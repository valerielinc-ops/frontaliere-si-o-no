import React, { useState, useMemo } from 'react';
import { Sliders, Baby, MapPin, Home, TrendingUp, TrendingDown, DollarSign, Heart, RotateCcw, Zap, Info } from 'lucide-react';
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { SimulationInputs, SimulationResult } from '@/types';
import { DEFAULT_INPUTS } from '@/constants';

interface WhatIfScenario {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
  fields: Array<{
    key: keyof SimulationInputs;
    label: string;
    type: 'slider' | 'select' | 'toggle';
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: any; label: string }>;
  }>;
}

interface WhatIfSimulatorProps {
  baseInputs: SimulationInputs;
  baseResult: SimulationResult;
}

const scenarios: WhatIfScenario[] = [
  {
    id: 'child',
    icon: <Baby size={24} />,
    title: 'Se avessi un figlio?',
    description: 'Scopri come cambiano assegni familiari e detrazioni',
    color: 'pink',
    fields: [
      { key: 'children', label: 'Numero di figli', type: 'slider', min: 0, max: 5, step: 1 },
      { key: 'familyMembers', label: 'Componenti nucleo', type: 'slider', min: 1, max: 6, step: 1 },
    ],
  },
  {
    id: 'salary',
    icon: <DollarSign size={24} />,
    title: 'Se cambiasse lo stipendio?',
    description: 'Vedi l\'impatto di un aumento o riduzione di RAL',
    color: 'emerald',
    fields: [
      { key: 'annualIncomeCHF', label: 'RAL Annua (CHF)', type: 'slider', min: 40000, max: 250000, step: 5000 },
    ],
  },
  {
    id: 'residence',
    icon: <Home size={24} />,
    title: 'Se prendessi la residenza CH?',
    description: 'Confronta tassazione residente CH vs frontaliere IT',
    color: 'blue',
    fields: [
      { key: 'frontierWorkerType', label: 'Tipo Frontaliere', type: 'select', options: [
        { value: 'NEW', label: 'Nuovo (dal 2024)' },
        { value: 'OLD', label: 'Vecchio (ante 2024)' },
      ]},
      { key: 'distanceZone', label: 'Zona distanza', type: 'select', options: [
        { value: 'WITHIN_20KM', label: 'Entro 20 km' },
        { value: 'OVER_20KM', label: 'Oltre 20 km' },
      ]},
    ],
  },
  {
    id: 'marital',
    icon: <Heart size={24} />,
    title: 'Se mi sposassi?',
    description: 'Effetto dello stato civile e coniuge lavoratore',
    color: 'rose',
    fields: [
      { key: 'maritalStatus', label: 'Stato Civile', type: 'select', options: [
        { value: 'SINGLE', label: 'Celibe/Nubile' },
        { value: 'MARRIED', label: 'Sposato/a' },
        { value: 'DIVORCED', label: 'Divorziato/a' },
        { value: 'WIDOWED', label: 'Vedovo/a' },
      ]},
      { key: 'spouseWorks', label: 'Coniuge lavoratore', type: 'toggle' },
    ],
  },
  {
    id: 'age',
    icon: <Zap size={24} />,
    title: 'Se avessi un\'altra età?',
    description: 'I contributi LPP cambiano con l\'età',
    color: 'amber',
    fields: [
      { key: 'age', label: 'Età', type: 'slider', min: 18, max: 65, step: 1 },
    ],
  },
];

const colorMap: Record<string, { bg: string; text: string; border: string; light: string }> = {
  pink: { bg: 'bg-pink-500', text: 'text-pink-600', border: 'border-pink-200 dark:border-pink-800', light: 'bg-pink-50 dark:bg-pink-950/30' },
  emerald: { bg: 'bg-emerald-500', text: 'text-emerald-600', border: 'border-emerald-200 dark:border-emerald-800', light: 'bg-emerald-50 dark:bg-emerald-950/30' },
  blue: { bg: 'bg-blue-500', text: 'text-blue-600', border: 'border-blue-200 dark:border-blue-800', light: 'bg-blue-50 dark:bg-blue-950/30' },
  rose: { bg: 'bg-rose-500', text: 'text-rose-600', border: 'border-rose-200 dark:border-rose-800', light: 'bg-rose-50 dark:bg-rose-950/30' },
  amber: { bg: 'bg-amber-500', text: 'text-amber-600', border: 'border-amber-200 dark:border-amber-800', light: 'bg-amber-50 dark:bg-amber-950/30' },
};

const WhatIfSimulator: React.FC<WhatIfSimulatorProps> = ({ baseInputs, baseResult }) => {
  const [modifiedInputs, setModifiedInputs] = useState<Partial<SimulationInputs>>({});
  const [activeScenario, setActiveScenario] = useState<string>('child');

  const whatIfInputs = useMemo(() => ({
    ...baseInputs,
    ...modifiedInputs,
  }), [baseInputs, modifiedInputs]);

  const whatIfResult = useMemo(() => {
    return calculateSimulation(whatIfInputs as SimulationInputs);
  }, [whatIfInputs]);

  const handleFieldChange = (key: keyof SimulationInputs, value: any) => {
    setModifiedInputs(prev => ({ ...prev, [key]: value }));
    Analytics.trackUIInteraction('WhatIf', 'change_param', `${key}:${value}`);
  };

  const handleReset = () => {
    setModifiedInputs({});
    Analytics.trackUIInteraction('WhatIf', 'reset', activeScenario);
  };

  const handleScenarioChange = (id: string) => {
    setActiveScenario(id);
    setModifiedInputs({});
    Analytics.trackUIInteraction('WhatIf', 'change_scenario', id);
  };

  // Calculate differences
  const baseNetIT = baseResult.itResident.netIncomeMonthly;
  const baseNetCH = baseResult.chResident.netIncomeMonthly;
  const newNetIT = whatIfResult.itResident.netIncomeMonthly;
  const newNetCH = whatIfResult.chResident.netIncomeMonthly;
  const diffIT = newNetIT - baseNetIT;
  const diffCH = newNetCH - baseNetCH;
  const baseSavings = baseResult.savingsEUR;
  const newSavings = whatIfResult.savingsEUR;
  const diffSavings = newSavings - baseSavings;

  const hasChanges = Object.keys(modifiedInputs).length > 0;

  const currentScenario = scenarios.find(s => s.id === activeScenario)!;
  const colors = colorMap[currentScenario.color];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-fuchsia-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Sliders size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">Simulatore "Cosa cambia se..."</h1>
            <p className="text-violet-100 mt-1">Esplora scenari what-if e vedi come cambiano le tue tasse in tempo reale</p>
          </div>
        </div>
      </div>

      {/* Scenario Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {scenarios.map(scenario => {
          const sc = colorMap[scenario.color];
          return (
            <button
              key={scenario.id}
              onClick={() => handleScenarioChange(scenario.id)}
              className={`flex items-center gap-2 px-4 py-3 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                activeScenario === scenario.id
                  ? `${sc.bg} text-white shadow-lg scale-105`
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:shadow-md'
              }`}
            >
              {scenario.icon}
              <span className="hidden sm:inline">{scenario.title}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className={`rounded-2xl border-2 ${colors.border} p-6 ${colors.light}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              {currentScenario.icon}
              {currentScenario.title}
            </h3>
            {hasChanges && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 transition-all"
              >
                <RotateCcw size={12} />
                Reset
              </button>
            )}
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{currentScenario.description}</p>

          <div className="space-y-6">
            {currentScenario.fields.map(field => {
              const currentVal = whatIfInputs[field.key as keyof SimulationInputs];
              const baseVal = baseInputs[field.key as keyof SimulationInputs];
              const isChanged = currentVal !== baseVal;

              return (
                <div key={String(field.key)} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">
                      {field.label}
                    </label>
                    {isChanged && (
                      <span className="text-xs font-bold text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 rounded-full">
                        Modificato
                      </span>
                    )}
                  </div>

                  {field.type === 'slider' && (
                    <div className="space-y-2">
                      <input
                        type="range"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={currentVal as number}
                        onChange={(e) => handleFieldChange(field.key, Number(e.target.value))}
                        className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-violet-600"
                      />
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>{field.min?.toLocaleString('it-IT')}</span>
                        <span className={`font-bold text-base ${isChanged ? 'text-violet-600' : 'text-slate-800 dark:text-slate-200'}`}>
                          {(currentVal as number).toLocaleString('it-IT')}
                          {field.key === 'annualIncomeCHF' && ' CHF'}
                        </span>
                        <span>{field.max?.toLocaleString('it-IT')}</span>
                      </div>
                    </div>
                  )}

                  {field.type === 'select' && (
                    <select
                      value={currentVal as string}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      className="w-full px-4 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                      {field.options?.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  )}

                  {field.type === 'toggle' && (
                    <button
                      onClick={() => handleFieldChange(field.key, !(currentVal as boolean))}
                      className={`relative w-14 h-7 rounded-full transition-colors ${
                        currentVal ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'
                      }`}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                        currentVal ? 'translate-x-7' : ''
                      }`} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Impact Cards */}
        <div className="lg:col-span-2 space-y-4">
          {/* Difference Summary */}
          <div className={`grid grid-cols-1 sm:grid-cols-3 gap-4 ${!hasChanges ? 'opacity-40' : ''}`}>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Netto IT (mensile)</div>
              <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                € {Math.round(newNetIT).toLocaleString('it-IT')}
              </div>
              {hasChanges && (
                <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffIT >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {diffIT >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {diffIT >= 0 ? '+' : ''}{Math.round(diffIT).toLocaleString('it-IT')} €
                </div>
              )}
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Netto CH (mensile)</div>
              <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                CHF {Math.round(newNetCH).toLocaleString('it-IT')}
              </div>
              {hasChanges && (
                <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffCH >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {diffCH >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {diffCH >= 0 ? '+' : ''}{Math.round(diffCH).toLocaleString('it-IT')} CHF
                </div>
              )}
            </div>

            <div className={`rounded-2xl border-2 p-5 shadow-sm ${newSavings >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'}`}>
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Risparmio annuo</div>
              <div className={`text-2xl font-extrabold ${newSavings >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                € {Math.round(newSavings).toLocaleString('it-IT')}
              </div>
              {hasChanges && (
                <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffSavings >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {diffSavings >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {diffSavings >= 0 ? '+' : ''}{Math.round(diffSavings).toLocaleString('it-IT')} €
                </div>
              )}
            </div>
          </div>

          {/* Detailed Comparison */}
          {hasChanges && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm animate-fade-in">
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
                <Info size={20} className="text-violet-600" />
                Dettaglio Impatto
              </h3>
              <div className="space-y-3">
                {/* IT Breakdown */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-slate-600 dark:text-slate-400">🇮🇹 Residenza Italia</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500">Lordo annuo</div>
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        € {Math.round(whatIfResult.itResident.grossIncome / whatIfResult.exchangeRate).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500">Tasse totali</div>
                      <div className="font-bold text-red-600">
                        € {Math.round(whatIfResult.itResident.taxes / whatIfResult.exchangeRate).toLocaleString('it-IT')}
                      </div>
                    </div>
                  </div>
                </div>

                {/* CH Breakdown */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-slate-600 dark:text-slate-400">🇨🇭 Residenza Svizzera</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500">Lordo annuo</div>
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        CHF {Math.round(whatIfResult.chResident.grossIncome).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500">Tasse totali</div>
                      <div className="font-bold text-red-600">
                        CHF {Math.round(whatIfResult.chResident.taxes).toLocaleString('it-IT')}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Summary */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                  <div className={`p-4 rounded-xl ${diffSavings >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                    <div className="text-sm text-slate-600 dark:text-slate-400">Con questo scenario il risparmio annuo cambia di:</div>
                    <div className={`text-3xl font-extrabold mt-1 ${diffSavings >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {diffSavings >= 0 ? '+' : ''}{Math.round(diffSavings).toLocaleString('it-IT')} €/anno
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      = {diffSavings >= 0 ? '+' : ''}{Math.round(diffSavings / 12).toLocaleString('it-IT')} €/mese
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!hasChanges && (
            <div className="bg-violet-50 dark:bg-violet-950/30 rounded-2xl border-2 border-dashed border-violet-300 dark:border-violet-700 p-8 text-center">
              <Sliders size={48} className="text-violet-400 mx-auto mb-4" />
              <p className="text-lg font-bold text-slate-700 dark:text-slate-300">Modifica i parametri a sinistra</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">I risultati si aggiorneranno in tempo reale</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WhatIfSimulator;
