import React, { useState } from 'react';
import { TrendingUp, PiggyBank, Calendar, Info, AlertCircle, CheckCircle2, ArrowRight, Users, Home, Banknote, Calculator, Clock, Globe, Percent } from 'lucide-react';

interface PensionInputs {
  currentAge: number;
  retirementAge: number;
  currentSalaryCHF: number;
  yearsWorkedCH: number;
  yearsWorkedIT: number;
  plannedYearsCH: number;
  hasItalianContributions: boolean;
  contributionRatePercent: number; // LPP rate based on age
  currentLPPCapital: number;
  expectedReturnRate: number;
  repatriationPlan: 'stay_ch' | 'return_it' | 'undecided';
}

interface PensionResult {
  lppAccumulated: number;
  lppMonthlyPension: number;
  avsPensionCHF: number;
  italianPensionEUR: number;
  totalMonthlyPensionCHF: number;
  capitalAtRetirement: number;
  yearsOfContributions: {
    switzerland: number;
    italy: number;
  };
}

const InfoTooltip = ({ text }: { text: string }) => (
  <div className="group relative inline-flex items-center ml-1.5 cursor-help">
    <Info size={14} className="text-slate-400 hover:text-indigo-500 transition-colors" />
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-64 p-3 bg-slate-800 dark:bg-slate-700 text-white text-xs leading-relaxed rounded-xl shadow-2xl z-50 border border-slate-600">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
    </div>
  </div>
);

const PensionPlanner: React.FC = () => {
  const [inputs, setInputs] = useState<PensionInputs>({
    currentAge: 35,
    retirementAge: 65,
    currentSalaryCHF: 80000,
    yearsWorkedCH: 5,
    yearsWorkedIT: 3,
    plannedYearsCH: 25,
    hasItalianContributions: true,
    contributionRatePercent: 7, // Default LPP rate 35-44 years
    currentLPPCapital: 25000,
    expectedReturnRate: 1.5,
    repatriationPlan: 'undecided'
  });

  const handleChange = (field: keyof PensionInputs, value: any) => {
    setInputs(prev => ({ ...prev, [field]: value }));
  };

  // Calculate LPP contribution rate based on age
  const getLPPRate = (age: number): number => {
    if (age < 25) return 0;
    if (age >= 25 && age <= 34) return 7;
    if (age >= 35 && age <= 44) return 10;
    if (age >= 45 && age <= 54) return 15;
    return 18; // 55+
  };

  // Calculate pension results
  const calculatePension = (): PensionResult => {
    const yearsUntilRetirement = inputs.retirementAge - inputs.currentAge;
    const avgYearlyContribution = (inputs.currentSalaryCHF * inputs.contributionRatePercent) / 100;
    
    // LPP accumulation with compound interest
    let lppTotal = inputs.currentLPPCapital;
    for (let year = 0; year < yearsUntilRetirement; year++) {
      const currentAge = inputs.currentAge + year;
      const rate = getLPPRate(currentAge);
      const contribution = (inputs.currentSalaryCHF * rate) / 100;
      lppTotal = lppTotal * (1 + inputs.expectedReturnRate / 100) + contribution;
    }

    // LPP monthly pension (conversion rate ~6.8% for 65 years old)
    const conversionRate = 0.068;
    const lppMonthlyPension = (lppTotal * conversionRate) / 12;

    // AVS calculation (simplified: full pension ~2450 CHF, proportional to years)
    const totalWorkYears = inputs.yearsWorkedCH + inputs.plannedYearsCH;
    const requiredYears = 44; // Full AVS requires 44 years
    const avsPensionCHF = Math.min((totalWorkYears / requiredYears) * 2450, 2450);

    // Italian pension (simplified: ~70% of last salary, proportional to years)
    const italianYears = inputs.yearsWorkedIT;
    const italianPensionEUR = inputs.hasItalianContributions 
      ? (italianYears / 35) * (inputs.currentSalaryCHF * 1.06 * 0.7) / 12
      : 0;

    const totalMonthlyPensionCHF = lppMonthlyPension + avsPensionCHF + (italianPensionEUR / 1.06);

    return {
      lppAccumulated: lppTotal,
      lppMonthlyPension,
      avsPensionCHF,
      italianPensionEUR,
      totalMonthlyPensionCHF,
      capitalAtRetirement: lppTotal,
      yearsOfContributions: {
        switzerland: totalWorkYears,
        italy: italianYears
      }
    };
  };

  const result = calculatePension();
  const yearsUntilRetirement = inputs.retirementAge - inputs.currentAge;

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="text-center space-y-3 mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl shadow-lg mb-4">
          <PiggyBank size={32} className="text-white" />
        </div>
        <h1 className="text-4xl font-extrabold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
          Pianificatore Pensionistico Frontaliere
        </h1>
        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          Simula la tua pensione futura considerando contributi svizzeri (LPP + AVS) e italiani. 
          Scopri quanto accumulerai e quanto riceverai mensilmente alla pensione.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Inputs */}
        <div className="space-y-4">
          {/* Personal Info */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Users className="text-emerald-600" size={20} />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Dati Personali</h3>
            </div>

            <div className="space-y-4">
              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Età Attuale
                  <InfoTooltip text="La tua età attuale per calcolare gli anni mancanti alla pensione" />
                </label>
                <input
                  type="number"
                  value={inputs.currentAge}
                  onChange={(e) => handleChange('currentAge', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  min="18"
                  max="70"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Età Pensionamento
                  <InfoTooltip text="Età prevista per il pensionamento (65 standard, 64 donne CH)" />
                </label>
                <input
                  type="number"
                  value={inputs.retirementAge}
                  onChange={(e) => handleChange('retirementAge', parseInt(e.target.value) || 65)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  min="55"
                  max="70"
                />
              </div>

              <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                  <Clock size={16} />
                  <span className="text-sm font-bold">
                    {yearsUntilRetirement} anni alla pensione
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Work History */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Calendar className="text-blue-600" size={20} />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Storico Lavorativo</h3>
            </div>

            <div className="space-y-4">
              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Anni Già Lavorati in Svizzera
                  <InfoTooltip text="Anni di contribuzione già versati al 2° pilastro (LPP)" />
                </label>
                <input
                  type="number"
                  value={inputs.yearsWorkedCH}
                  onChange={(e) => handleChange('yearsWorkedCH', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="50"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Anni Previsti Futuri in CH
                  <InfoTooltip text="Per quanti anni ancora prevedi di lavorare in Svizzera" />
                </label>
                <input
                  type="number"
                  value={inputs.plannedYearsCH}
                  onChange={(e) => handleChange('plannedYearsCH', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="50"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  <input
                    type="checkbox"
                    checked={inputs.hasItalianContributions}
                    onChange={(e) => handleChange('hasItalianContributions', e.target.checked)}
                    className="mr-2 w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  Ho contributi previdenziali italiani
                  <InfoTooltip text="Se hai lavorato in Italia e versato contributi INPS" />
                </label>
              </div>

              {inputs.hasItalianContributions && (
                <div>
                  <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                    Anni Lavorati in Italia
                    <InfoTooltip text="Anni di contributi INPS versati in Italia" />
                  </label>
                  <input
                    type="number"
                    value={inputs.yearsWorkedIT}
                    onChange={(e) => handleChange('yearsWorkedIT', parseInt(e.target.value) || 0)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0"
                    max="50"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Financial Info */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Banknote className="text-purple-600" size={20} />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Dati Finanziari</h3>
            </div>

            <div className="space-y-4">
              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Salario Lordo Annuo (CHF)
                  <InfoTooltip text="Il tuo stipendio lordo annuale attuale in Svizzera" />
                </label>
                <input
                  type="number"
                  value={inputs.currentSalaryCHF}
                  onChange={(e) => handleChange('currentSalaryCHF', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  step="1000"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Capitale LPP Attuale (CHF)
                  <InfoTooltip text="Avere attuale nel tuo 2° pilastro (visibile sul certificato LPP)" />
                </label>
                <input
                  type="number"
                  value={inputs.currentLPPCapital}
                  onChange={(e) => handleChange('currentLPPCapital', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  step="5000"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Tasso Rendimento LPP (% annuo)
                  <InfoTooltip text="Tasso di interesse annuo previsto sul 2° pilastro (1-2% realistico)" />
                </label>
                <input
                  type="number"
                  value={inputs.expectedReturnRate}
                  onChange={(e) => handleChange('expectedReturnRate', parseFloat(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  max="5"
                  step="0.1"
                />
              </div>
            </div>
          </div>

          {/* Repatriation Plan */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Globe className="text-orange-600" size={20} />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Piano di Rimpatrio</h3>
            </div>

            <div className="space-y-3">
              <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Dove prevedi di vivere in pensione?
                <InfoTooltip text="Importante per il calcolo delle tasse sul 2° pilastro e le procedure di ritiro" />
              </label>

              {(['stay_ch', 'return_it', 'undecided'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => handleChange('repatriationPlan', option)}
                  className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
                    inputs.repatriationPlan === option
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {inputs.repatriationPlan === option && (
                      <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
                    )}
                    <div className="flex-1">
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        {option === 'stay_ch' && '🇨🇭 Resto in Svizzera'}
                        {option === 'return_it' && '🇮🇹 Ritorno in Italia'}
                        {option === 'undecided' && '🤔 Non ancora deciso'}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {option === 'stay_ch' && 'Pensione diretta, tasse svizzere sul capitale'}
                        {option === 'return_it' && 'Possibile anticipo LPP, tasse di uscita CH'}
                        {option === 'undecided' && 'Valuteremo entrambe le opzioni'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Results */}
        <div className="space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 gap-4">
            {/* Total Monthly Pension */}
            <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-6 shadow-lg text-white">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-emerald-100 text-sm font-semibold uppercase tracking-wide mb-1">
                    Pensione Mensile Totale
                  </div>
                  <div className="text-4xl font-extrabold">
                    CHF {Math.round(result.totalMonthlyPensionCHF).toLocaleString('it-IT')}
                  </div>
                </div>
                <TrendingUp size={32} className="text-emerald-200" />
              </div>
              <div className="text-emerald-100 text-xs">
                Stima basata su {yearsUntilRetirement} anni di contributi futuri
              </div>
            </div>

            {/* LPP Capital */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                  <PiggyBank className="text-blue-600" size={20} />
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                    Capitale 2° Pilastro (LPP)
                  </div>
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    CHF {Math.round(result.lppAccumulated).toLocaleString('it-IT')}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700">
                <span className="text-sm text-slate-600 dark:text-slate-400">Rendita mensile:</span>
                <span className="text-lg font-bold text-blue-600">
                  CHF {Math.round(result.lppMonthlyPension).toLocaleString('it-IT')}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <InfoTooltip text="Tasso conversione 6.8% - Capitale può essere prelevato in parte o totalmente" />
                Conversione: 6.8% annuo (standard)
              </div>
            </div>

            {/* AVS Pension */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg">
                  <Home className="text-red-600" size={20} />
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                    Pensione AVS (1° Pilastro)
                  </div>
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    CHF {Math.round(result.avsPensionCHF).toLocaleString('it-IT')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Calculator size={12} />
                <span>
                  {result.yearsOfContributions.switzerland} anni di contributi / 44 necessari
                </span>
              </div>
              <div className="mt-2 w-full bg-slate-100 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-red-500 h-full rounded-full transition-all"
                  style={{ width: `${Math.min((result.yearsOfContributions.switzerland / 44) * 100, 100)}%` }}
                />
              </div>
            </div>

            {/* Italian Pension */}
            {inputs.hasItalianContributions && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
                    <Globe className="text-green-600" size={20} />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                      Pensione INPS Italia
                    </div>
                    <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                      € {Math.round(result.italianPensionEUR).toLocaleString('it-IT')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Calculator size={12} />
                  <span>
                    {inputs.yearsWorkedIT} anni di contributi italiani
                  </span>
                </div>
                <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-700 dark:text-blue-400">
                  <strong>Nota:</strong> Pensione proporzionale ai contributi versati in Italia
                </div>
              </div>
            )}
          </div>

          {/* Breakdown Table */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
              <Calculator size={20} className="text-emerald-600" />
              Dettaglio Pensione Mensile
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Rendita LPP (2° Pilastro)</span>
                <span className="text-lg font-bold text-blue-600">
                  CHF {Math.round(result.lppMonthlyPension).toLocaleString('it-IT')}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Pensione AVS (1° Pilastro)</span>
                <span className="text-lg font-bold text-red-600">
                  CHF {Math.round(result.avsPensionCHF).toLocaleString('it-IT')}
                </span>
              </div>

              {inputs.hasItalianContributions && result.italianPensionEUR > 0 && (
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Pensione INPS Italia</span>
                  <span className="text-lg font-bold text-green-600">
                    € {Math.round(result.italianPensionEUR).toLocaleString('it-IT')}
                  </span>
                </div>
              )}

              <div className="border-t-2 border-emerald-500 pt-3 mt-3">
                <div className="flex items-center justify-between p-4 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl">
                  <span className="text-base font-bold text-slate-800 dark:text-slate-100">Totale Mensile</span>
                  <span className="text-2xl font-extrabold text-emerald-600">
                    CHF {Math.round(result.totalMonthlyPensionCHF).toLocaleString('it-IT')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Repatriation Info */}
          {inputs.repatriationPlan !== 'undecided' && (
            <div className={`rounded-2xl border-2 p-6 ${
              inputs.repatriationPlan === 'stay_ch'
                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
                : 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800'
            }`}>
              <div className="flex items-start gap-3 mb-3">
                <AlertCircle 
                  size={24} 
                  className={inputs.repatriationPlan === 'stay_ch' ? 'text-blue-600' : 'text-orange-600'} 
                />
                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2">
                    {inputs.repatriationPlan === 'stay_ch' ? '🇨🇭 Scenario: Pensione in Svizzera' : '🇮🇹 Scenario: Rimpatrio in Italia'}
                  </h4>
                  <ul className="text-sm space-y-1 text-slate-600 dark:text-slate-400">
                    {inputs.repatriationPlan === 'stay_ch' ? (
                      <>
                        <li>✓ Rendita LPP erogata direttamente dal fondo pensione</li>
                        <li>✓ AVS versata mensilmente in Svizzera</li>
                        <li>✓ Tassazione svizzera sulla rendita pensionistica</li>
                        <li>✓ Possibile prelievo anticipato capitale (max 100%)</li>
                      </>
                    ) : (
                      <>
                        <li>⚠️ Prelievo capitale LPP con tassa di uscita 5-10%</li>
                        <li>✓ AVS versata anche all'estero (coordinate bancarie IT)</li>
                        <li>⚠️ Pensione italiana tassata in Italia (IRPEF)</li>
                        <li>⚠️ Convenzione fiscale: evita doppia imposizione</li>
                      </>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Important Notes */}
          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm text-amber-800 dark:text-amber-200">
                <p className="font-bold">⚠️ Disclaimer Importante</p>
                <ul className="space-y-1 text-xs">
                  <li>• Calcoli indicativi basati su tassi attuali (possono cambiare)</li>
                  <li>• Tasso conversione LPP: 6.8% per 65 anni (può variare nel futuro)</li>
                  <li>• AVS: calcolo semplificato, per importo preciso consultare AVS</li>
                  <li>• Pensione italiana: stima approssimativa, verificare con INPS</li>
                  <li>• Consigliamo consultazione con consulente previdenziale certificato</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PensionPlanner;
