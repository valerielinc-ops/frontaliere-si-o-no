import React, { useState, useMemo } from 'react';
import { Shield, TrendingUp, Calculator, Info, AlertCircle, Landmark, PiggyBank, Percent, Clock, Star, Building, Banknote, BarChart3, CheckCircle2, XCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Area, AreaChart } from 'recharts';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';

interface Pillar3Inputs {
  type: '3a' | '3b';
  annualContribution: number;
  currentCapital: number;
  expectedReturn: number;
  projectionYears: number;
  marginalTaxRate: number;
  age: number;
}

const MAX_3A_2026 = 7258; // Max per dipendenti con 2° pilastro
const MAX_3A_NO_LPP = 36288; // Max per autonomi senza 2° pilastro

const Pillar3Simulator: React.FC = () => {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<Pillar3Inputs>({
    type: '3a',
    annualContribution: 7258,
    currentCapital: 0,
    expectedReturn: 2.0,
    projectionYears: 20,
    marginalTaxRate: 35,
    age: 35,
  });

  const handleChange = (field: keyof Pillar3Inputs, value: any) => {
    setInputs(prev => ({ ...prev, [field]: value }));
    Analytics.trackUIInteraction('Pillar3', 'change_param', `${field}:${value}`);
  };

  const results = useMemo(() => {
    const { annualContribution, currentCapital, expectedReturn, projectionYears, marginalTaxRate } = inputs;
    const rate = expectedReturn / 100;
    
    const projections: Array<{ year: number; withPillar: number; withoutPillar: number; taxSaved: number; age: number }> = [];
    
    let capitalWithPillar = currentCapital;
    let capitalWithoutPillar = currentCapital;
    let totalTaxSaved = 0;
    
    for (let y = 0; y <= projectionYears; y++) {
      const annualTaxSaving = inputs.type === '3a' ? annualContribution * (marginalTaxRate / 100) : 0;
      totalTaxSaved += y > 0 ? annualTaxSaving : 0;
      
      projections.push({
        year: y,
        withPillar: Math.round(capitalWithPillar),
        withoutPillar: Math.round(capitalWithoutPillar),
        taxSaved: Math.round(totalTaxSaved),
        age: inputs.age + y,
      });
      
      capitalWithPillar = (capitalWithPillar + annualContribution) * (1 + rate);
      capitalWithoutPillar = (capitalWithoutPillar + annualContribution) * (1 + (rate * 0.7)); // Without tax advantage, lower effective return
    }

    const totalContributed = currentCapital + annualContribution * projectionYears;
    const totalGains = capitalWithPillar - totalContributed;
    const annualTaxSaving = inputs.type === '3a' ? annualContribution * (marginalTaxRate / 100) : 0;

    // Withdrawal tax (rough estimate: 5-8% for 3a)
    const withdrawalTaxRate = inputs.type === '3a' ? 0.06 : 0;
    const withdrawalTax = capitalWithPillar * withdrawalTaxRate;
    const netAfterWithdrawal = capitalWithPillar - withdrawalTax;

    return {
      projections,
      finalCapital: Math.round(capitalWithPillar),
      totalContributed: Math.round(totalContributed),
      totalGains: Math.round(totalGains),
      annualTaxSaving: Math.round(annualTaxSaving),
      totalTaxSaved: Math.round(totalTaxSaved),
      withdrawalTax: Math.round(withdrawalTax),
      netAfterWithdrawal: Math.round(netAfterWithdrawal),
    };
  }, [inputs]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-teal-600 via-emerald-600 to-green-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Landmark size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{t('pillar3.title')}</h1>
            <p className="text-teal-100 mt-1">{t('pillar3.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Inputs */}
        <div className="space-y-4">
          {/* Type Selection */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
              <Shield size={20} className="text-teal-600" />
              {t('pillar3.pillarType')}
            </h3>
            
            <div className="space-y-3">
              <button
                onClick={() => { handleChange('type', '3a'); handleChange('annualContribution', MAX_3A_2026); }}
                className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
                  inputs.type === '3a' ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                }`}
              >
                <div className="font-bold text-slate-800 dark:text-slate-100">🏛️ {t('pillar3.type3a')}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {t('pillar3.type3aDesc')}
                </div>
              </button>
              
              <button
                onClick={() => handleChange('type', '3b')}
                className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
                  inputs.type === '3b' ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                }`}
              >
                <div className="font-bold text-slate-800 dark:text-slate-100">💰 {t('pillar3.type3b')}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {t('pillar3.type3bDesc')}
                </div>
              </button>
            </div>
          </div>

          {/* Parameters */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Calculator size={20} className="text-teal-600" />
              {t('pillar3.parameters')}
            </h3>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('pillar3.annualContribution')}</label>
              <input type="number" value={inputs.annualContribution}
                onChange={(e) => handleChange('annualContribution', Math.min(Number(e.target.value), inputs.type === '3a' ? MAX_3A_2026 : 100000))}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold focus:outline-none focus:ring-2 focus:ring-teal-500"
                max={inputs.type === '3a' ? MAX_3A_2026 : 100000} min={0} step={100} />
              {inputs.type === '3a' && <p className="text-xs text-teal-600 mt-1">Max 2026: CHF {MAX_3A_2026.toLocaleString('it-IT')}</p>}
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('pillar3.currentCapital')}</label>
              <input type="number" value={inputs.currentCapital}
                onChange={(e) => handleChange('currentCapital', Number(e.target.value))}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold focus:outline-none focus:ring-2 focus:ring-teal-500"
                min={0} step={1000} />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 flex items-center gap-2">
                {t('pillar3.expectedReturn')}
              </label>
              <input type="range" min={0} max={6} step={0.25} value={inputs.expectedReturn}
                onChange={(e) => handleChange('expectedReturn', Number(e.target.value))}
                className="w-full accent-teal-600" />
              <div className="text-center font-bold text-teal-600">{inputs.expectedReturn}%</div>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('pillar3.projectionYears')}</label>
              <input type="range" min={5} max={40} step={5} value={inputs.projectionYears}
                onChange={(e) => handleChange('projectionYears', Number(e.target.value))}
                className="w-full accent-teal-600" />
              <div className="flex justify-between text-xs text-slate-500">
                <span>5</span>
                <span className="font-bold text-teal-600 text-base">{inputs.projectionYears} {t('pillar3.years')}</span>
                <span>40</span>
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('pillar3.marginalRate')}</label>
              <input type="range" min={10} max={50} step={1} value={inputs.marginalTaxRate}
                onChange={(e) => handleChange('marginalTaxRate', Number(e.target.value))}
                className="w-full accent-teal-600" />
              <div className="text-center font-bold text-teal-600">{inputs.marginalTaxRate}%</div>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('pillar3.currentAge')}</label>
              <input type="number" value={inputs.age}
                onChange={(e) => handleChange('age', Number(e.target.value))}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold focus:outline-none focus:ring-2 focus:ring-teal-500"
                min={18} max={65} />
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-gradient-to-br from-teal-500 to-emerald-600 rounded-2xl p-5 text-white shadow-lg">
              <div className="text-teal-100 text-xs font-bold uppercase mb-1">{t('pillar3.finalCapital')}</div>
              <div className="text-3xl font-extrabold">CHF {results.finalCapital.toLocaleString('it-IT')}</div>
              <div className="text-teal-100 text-xs mt-1">{t('pillar3.inYears', { years: inputs.projectionYears })}</div>
            </div>

            {inputs.type === '3a' && (
              <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl p-5 text-white shadow-lg">
                <div className="text-amber-100 text-xs font-bold uppercase mb-1">{t('pillar3.annualTaxSaving')}</div>
                <div className="text-3xl font-extrabold">CHF {results.annualTaxSaving.toLocaleString('it-IT')}</div>
                <div className="text-amber-100 text-xs mt-1">{t('pillar3.total')}: CHF {results.totalTaxSaved.toLocaleString('it-IT')}</div>
              </div>
            )}

            <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl p-5 text-white shadow-lg">
              <div className="text-blue-100 text-xs font-bold uppercase mb-1">{t('pillar3.totalReturn')}</div>
              <div className="text-3xl font-extrabold">CHF {results.totalGains.toLocaleString('it-IT')}</div>
              <div className="text-blue-100 text-xs mt-1">{t('pillar3.invested')}: CHF {results.totalContributed.toLocaleString('it-IT')}</div>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
              <TrendingUp size={20} className="text-teal-600" />
              {t('pillar3.growthProjection')}
            </h3>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={results.projections}>
                <defs>
                  <linearGradient id="colorPillar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorTax" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="age" tick={{ fontSize: 12 }} label={{ value: t('pillar3.age'), position: 'insideBottom', offset: -5 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(value: number) => [`CHF ${value.toLocaleString('it-IT')}`, '']} labelFormatter={(label) => `${t('pillar3.age')}: ${label}`} />
                <Legend />
                <Area type="monotone" dataKey="withPillar" name={t('pillar3.capitalPillar3')} stroke="#14b8a6" fill="url(#colorPillar)" strokeWidth={2} />
                {inputs.type === '3a' && (
                  <Area type="monotone" dataKey="taxSaved" name={t('pillar3.cumulativeTaxSaving')} stroke="#f59e0b" fill="url(#colorTax)" strokeWidth={2} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Withdrawal Info */}
          {inputs.type === '3a' && (
            <div className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-6">
              <div className="flex items-start gap-3">
                <AlertCircle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2">{t('pillar3.withdrawalTitle')}</h4>
                  <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                    <p>{t('pillar3.withdrawalDesc')}</p>
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div className="p-3 bg-white dark:bg-slate-900 rounded-lg">
                        <div className="text-xs text-slate-500">{t('pillar3.estimatedWithdrawalTax')}</div>
                        <div className="font-bold text-red-600">CHF {results.withdrawalTax.toLocaleString('it-IT')}</div>
                      </div>
                      <div className="p-3 bg-white dark:bg-slate-900 rounded-lg">
                        <div className="text-xs text-slate-500">{t('pillar3.netAfterTax')}</div>
                        <div className="font-bold text-emerald-600">CHF {results.netAfterWithdrawal.toLocaleString('it-IT')}</div>
                      </div>
                    </div>
                    <p className="text-xs mt-2">
                      <strong>{t('pillar3.withdrawalAdvice')}</strong>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 3a vs 3b Comparison */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
            <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
              <Info size={18} className="text-blue-600" />
              {t('pillar3.comparison3a3b')}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-blue-200 dark:border-blue-700">
                    <th className="text-left py-2 text-slate-600 dark:text-slate-400">{t('pillar3.feature')}</th>
                    <th className="text-center py-2 text-teal-600 font-bold">{t('pillar3.type3aShort')}</th>
                    <th className="text-center py-2 text-purple-600 font-bold">{t('pillar3.type3bShort')}</th>
                  </tr>
                </thead>
                <tbody className="text-slate-700 dark:text-slate-300">
                  <tr className="border-b border-blue-100 dark:border-blue-800">
                    <td className="py-2">{t('pillar3.taxDeductibility')}</td>
                    <td className="text-center py-2 font-bold text-emerald-600">100%</td>
                    <td className="text-center py-2">{t('pillar3.partialCanton')}</td>
                  </tr>
                  <tr className="border-b border-blue-100 dark:border-blue-800">
                    <td className="py-2">{t('pillar3.maxAnnualAmount')}</td>
                    <td className="text-center py-2 font-bold">CHF {MAX_3A_2026.toLocaleString('it-IT')}</td>
                    <td className="text-center py-2">{t('pillar3.unlimited')}</td>
                  </tr>
                  <tr className="border-b border-blue-100 dark:border-blue-800">
                    <td className="py-2">{t('pillar3.withdrawal')}</td>
                    <td className="text-center py-2">{t('pillar3.fiveYearsBefore')}</td>
                    <td className="text-center py-2 font-bold text-emerald-600">{t('pillar3.free')}</td>
                  </tr>
                  <tr className="border-b border-blue-100 dark:border-blue-800">
                    <td className="py-2">{t('pillar3.withdrawalTaxation')}</td>
                    <td className="text-center py-2">{t('pillar3.separateTax')}</td>
                    <td className="text-center py-2">{t('pillar3.ordinaryIncome')}</td>
                  </tr>
                  <tr>
                    <td className="py-2">{t('pillar3.idealFor')}</td>
                    <td className="text-center py-2 text-xs">{t('pillar3.maxTaxSaving')}</td>
                    <td className="text-center py-2 text-xs">{t('pillar3.flexibility')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Investment Options Comparison */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
              <BarChart3 size={20} className="text-indigo-600" />
              {t('pillar3.investmentComparison')}
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
              {t('pillar3.investmentDesc')}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Bank Account */}
              <div className="border-2 border-slate-200 dark:border-slate-700 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                    <Banknote size={20} className="text-blue-600" />
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-800 dark:text-slate-100">Conto Bancario</h4>
                    <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full font-bold">{t('pillar3.lowRisk')}</span>
                  </div>
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-1.5 mb-1"><Percent size={12} className="text-slate-500" /> {t('pillar3.return')}: <span className="font-bold">0.5-1.5%</span></div>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.guaranteedCapital')}</div>
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.noKnowledgeRequired')}</div>
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.maxSafety')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.belowInflation')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.noRealGrowth')}</div>
                </div>
                <div className="pt-2 border-t border-slate-100 dark:border-slate-700">
                  <p className="text-xs text-slate-500 italic">{t('pillar3.exampleBanks')}</p>
                </div>
              </div>

              {/* Investment Funds */}
              <div className="border-2 border-indigo-300 dark:border-indigo-700 rounded-xl p-5 space-y-3 ring-2 ring-indigo-100 dark:ring-indigo-900/30">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                    <TrendingUp size={20} className="text-indigo-600" />
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-800 dark:text-slate-100">{t('pillar3.investmentFunds')}</h4>
                    <span className="text-xs px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full font-bold">{t('pillar3.mediumRisk')}</span>
                  </div>
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-1.5 mb-1"><Percent size={12} className="text-slate-500" /> {t('pillar3.return')}: <span className="font-bold">2-5%</span></div>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.goodRiskReturn')}</div>
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.autoDiversification')}</div>
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.professionalManagement')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.managementFees')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.shortTermLosses')}</div>
                </div>
                <div className="pt-2 border-t border-slate-100 dark:border-slate-700">
                  <p className="text-xs text-slate-500 italic">{t('pillar3.exampleFunds')}</p>
                </div>
              </div>

              {/* Insurance */}
              <div className="border-2 border-slate-200 dark:border-slate-700 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                    <Shield size={20} className="text-purple-600" />
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-800 dark:text-slate-100">{t('pillar3.lifeInsurance')}</h4>
                    <span className="text-xs px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full font-bold">{t('pillar3.lowRisk')}</span>
                  </div>
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-1.5 mb-1"><Percent size={12} className="text-slate-500" /> {t('pillar3.return')}: <span className="font-bold">0.5-2%</span></div>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.insuranceCoverage')}</div>
                  <div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 size={12} /> {t('pillar3.forcedSaving')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.lowNetReturn')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.longContract')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.hiddenCosts')}</div>
                  <div className="flex items-center gap-1.5 text-red-500"><XCircle size={12} /> {t('pillar3.earlyPenalties')}</div>
                </div>
                <div className="pt-2 border-t border-slate-100 dark:border-slate-700">
                  <p className="text-xs text-slate-500 italic">{t('pillar3.exampleInsurance')}</p>
                </div>
              </div>
            </div>

            {/* Provider comparison table */}
            <div className="mt-6 overflow-x-auto">
              <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <Star size={16} className="text-amber-500" />
                {t('pillar3.topProviders')}
              </h4>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-200 dark:border-slate-700">
                    <th className="text-left py-2 text-slate-600 dark:text-slate-400">{t('pillar3.provider')}</th>
                    <th className="text-center py-2 text-slate-600 dark:text-slate-400">{t('pillar3.type')}</th>
                    <th className="text-center py-2 text-slate-600 dark:text-slate-400">{t('pillar3.costs')}</th>
                    <th className="text-center py-2 text-slate-600 dark:text-slate-400">{t('pillar3.historicalReturn')}</th>
                    <th className="text-center py-2 text-slate-600 dark:text-slate-400">{t('pillar3.minInvestment')}</th>
                    <th className="text-center py-2 text-slate-600 dark:text-slate-400">{t('pillar3.rating')}</th>
                  </tr>
                </thead>
                <tbody className="text-slate-700 dark:text-slate-300">
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2.5 font-bold">VIAC</td>
                    <td className="text-center py-2.5">{t('pillar3.indexFunds')}</td>
                    <td className="text-center py-2.5 font-bold text-emerald-600">0.44%</td>
                    <td className="text-center py-2.5">~4-6%</td>
                    <td className="text-center py-2.5">CHF 0</td>
                    <td className="text-center py-2.5">⭐⭐⭐⭐⭐</td>
                  </tr>
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2.5 font-bold">finpension</td>
                    <td className="text-center py-2.5">{t('pillar3.indexFunds')}</td>
                    <td className="text-center py-2.5 font-bold text-emerald-600">0.39%</td>
                    <td className="text-center py-2.5">~4-6%</td>
                    <td className="text-center py-2.5">CHF 0</td>
                    <td className="text-center py-2.5">⭐⭐⭐⭐⭐</td>
                  </tr>
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2.5 font-bold">frankly (ZKB)</td>
                    <td className="text-center py-2.5">{t('pillar3.mixedFunds')}</td>
                    <td className="text-center py-2.5">0.45%</td>
                    <td className="text-center py-2.5">~3-5%</td>
                    <td className="text-center py-2.5">CHF 0</td>
                    <td className="text-center py-2.5">⭐⭐⭐⭐</td>
                  </tr>
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2.5 font-bold">Selma Finance</td>
                    <td className="text-center py-2.5">Robo-advisor</td>
                    <td className="text-center py-2.5">0.68%</td>
                    <td className="text-center py-2.5">~3-5%</td>
                    <td className="text-center py-2.5">CHF 2'000</td>
                    <td className="text-center py-2.5">⭐⭐⭐⭐</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-bold">Banca tradizionale</td>
                    <td className="text-center py-2.5">{t('pillar3.savingsAccount')}</td>
                    <td className="text-center py-2.5 text-red-500">0.00%</td>
                    <td className="text-center py-2.5">~0.5-1%</td>
                    <td className="text-center py-2.5">CHF 0</td>
                    <td className="text-center py-2.5">⭐⭐</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-4 p-4 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                <strong className="text-emerald-700 dark:text-emerald-400">{t('pillar3.investmentAdvice')}</strong>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Pillar3Simulator;
