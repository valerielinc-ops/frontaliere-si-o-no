import React, { useEffect, useState } from 'react';
import { Wand2, Castle, Bandage, PiggyBank, ToyBrick, CalendarClock, Loader2, Joystick, Hourglass, AlertCircle, Plus, Minus, ChevronDown, ChevronUp, Check, TrainFront, Coins, HeartHandshake, VenetianMask, Briefcase } from 'lucide-react';
import { SimulationInputs } from '../types';

interface Props {
  inputs: SimulationInputs;
  setInputs: React.Dispatch<React.SetStateAction<SimulationInputs>>;
  onCalculate: () => void; 
}

export const InputCard: React.FC<Props> = ({ inputs, setInputs }) => {
  const [loadingRate, setLoadingRate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Sections state - keep them open by default for visibility
  const [openSections, setOpenSections] = useState({
    advanced: true
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections(prev => ({...prev, [key]: !prev[key]}));
  };

  const handleChange = (field: keyof SimulationInputs, value: any) => {
    // Validation Logic
    if (field === 'familyMembers') {
      const newFamilyMembers = Number(value);
      if (newFamilyMembers < 1) return; 
      if (newFamilyMembers <= inputs.children) {
         setError("Famiglia deve essere > figli (almeno 1 adulto).");
      } else {
         setError(null);
      }
    }
    
    if (field === 'children') {
      const newChildren = Number(value);
      if (newChildren < 0) return;
      if (newChildren >= inputs.familyMembers) {
         setError("I figli non possono superare i membri totali.");
      } else {
         setError(null);
      }
    }

    setInputs(prev => ({ ...prev, [field]: value }));
  };

  const increment = (field: 'familyMembers' | 'children' | 'monthsBasis' | 'age') => {
    handleChange(field, inputs[field] + 1);
  };

  const decrement = (field: 'familyMembers' | 'children' | 'monthsBasis' | 'age') => {
    const min = field === 'children' ? 0 : 1;
    if (inputs[field] > min) {
      handleChange(field, inputs[field] - 1);
    }
  };

  const formatNumber = (value: number): string => {
    if (value === 0) return '';
    return value.toLocaleString('it-IT');
  };

  const parseNumber = (value: string): number => {
    const cleanValue = value.replace(/\./g, '').replace(/[^0-9]/g, '');
    return cleanValue === '' ? 0 : parseInt(cleanValue, 10);
  };

  useEffect(() => {
    handleChange('healthInsuranceCHF', inputs.familyMembers * 400);
  }, [inputs.familyMembers]);

  useEffect(() => {
    const fetchRate = async () => {
      setLoadingRate(true);
      try {
        const res = await fetch('https://api.frankfurter.app/latest?from=CHF&to=EUR');
        const data = await res.json();
        if (data?.rates?.EUR) handleChange('customExchangeRate', data.rates.EUR);
      } catch (e) {
        console.error("Failed rate fetch", e);
      } finally {
        setLoadingRate(false);
      }
    };
    fetchRate();
  }, []);

  return (
    <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl shadow-xl border border-white/60 dark:border-slate-700 h-full flex flex-col overflow-hidden transition-colors duration-300">
      {/* Header */}
      <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-white/50 dark:bg-slate-900/50 w-full z-10 relative">
        <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-xl shadow-sm">
              <Wand2 size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">Parametri</h2>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-bold">Configura il simulatore</p>
            </div>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto custom-scrollbar bg-slate-50/50 dark:bg-slate-950/50 p-4 space-y-4">
        
        {/* SECTION 1: REDDITO - Card */}
        <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm transition-all hover:shadow-md">
           <div className="flex items-center justify-between mb-3">
               <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-2">
                 <PiggyBank size={14} className="text-pink-500" /> Reddito
               </h3>
           </div>
           
           <div className="space-y-1">
             <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Lordo Annuale</label>
             <div className="relative group">
                 <input
                 type="text"
                 inputMode="numeric"
                 value={formatNumber(inputs.annualIncomeCHF)}
                 onChange={(e) => handleChange('annualIncomeCHF', parseNumber(e.target.value))}
                 className="w-full pl-4 pr-12 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-pink-100 dark:focus:ring-pink-900/30 focus:border-pink-500 outline-none transition-all font-bold text-slate-800 dark:text-slate-100 text-lg group-hover:bg-white dark:group-hover:bg-slate-800"
                 />
                 <span className="absolute right-4 top-3.5 text-slate-400 dark:text-slate-500 font-bold text-sm">CHF</span>
             </div>
           </div>
        </div>

        {/* SECTION 2: FAMIGLIA - Card */}
        <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm transition-all hover:shadow-md">
           <div className="flex items-center justify-between mb-3">
               <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-2">
                 <Castle size={14} className="text-blue-500" /> Famiglia & Spese
               </h3>
           </div>

           <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Membri</label>
                  <div className="flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm h-11">
                    <button onClick={() => decrement('familyMembers')} className="w-10 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors border-r border-slate-200 dark:border-slate-700 flex items-center justify-center">
                        <Minus size={16} />
                    </button>
                    <input
                        type="number"
                        value={inputs.familyMembers}
                        readOnly
                        className="w-full bg-transparent text-center font-bold text-slate-800 dark:text-slate-100 outline-none m-0"
                    />
                    <button onClick={() => increment('familyMembers')} className="w-10 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors border-l border-slate-200 dark:border-slate-700 flex items-center justify-center">
                        <Plus size={16} />
                    </button>
                  </div>
              </div>
              <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Figli</label>
                  <div className="flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm h-11">
                    <button onClick={() => decrement('children')} className="w-10 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors border-r border-slate-200 dark:border-slate-700 flex items-center justify-center">
                        <Minus size={16} />
                    </button>
                    <input
                        type="number"
                        value={inputs.children}
                        readOnly
                        className="w-full bg-transparent text-center font-bold text-slate-800 dark:text-slate-100 outline-none m-0"
                    />
                    <button onClick={() => increment('children')} className="w-10 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors border-l border-slate-200 dark:border-slate-700 flex items-center justify-center">
                        <Plus size={16} />
                    </button>
                  </div>
              </div>
           </div>

           <div className="space-y-1">
             <label className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1">
               <Bandage size={12} className="text-red-400" /> Cassa Malati (Tot. Mensile)
             </label>
             <div className="relative">
                 <input
                 type="text"
                 inputMode="numeric"
                 value={formatNumber(inputs.healthInsuranceCHF)}
                 onChange={(e) => handleChange('healthInsuranceCHF', parseNumber(e.target.value))}
                 className="w-full pl-4 pr-12 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-red-50 dark:focus:ring-red-900/30 focus:border-red-400 outline-none transition-all font-bold text-slate-700 dark:text-slate-200"
                 />
                 <span className="absolute right-4 top-2.5 text-slate-400 dark:text-slate-500 font-bold text-xs">CHF</span>
             </div>
           </div>

           {error && (
              <div className="mt-3 p-2.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-[10px] font-bold rounded-lg flex items-start gap-2 border border-red-100 dark:border-red-800">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
              </div>
           )}
        </div>

        {/* SECTION 3: TIPO FRONTALIERE - Card */}
        <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm transition-all hover:shadow-md">
           <div className="flex items-center justify-between mb-3">
               <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-2">
                 <TrainFront size={14} className="text-emerald-500" /> Tipologia
               </h3>
           </div>
           
           <div className="grid grid-cols-2 gap-3">
              <button 
                  onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); }}
                  className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center text-center gap-1 ${inputs.frontierWorkerType === 'NEW' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/30' : 'border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-200 dark:hover:border-slate-600'}`}
              >
                  {inputs.frontierWorkerType === 'NEW' && <div className="absolute top-2 right-2"><Check size={14} className="text-blue-600 dark:text-blue-400" /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'NEW' ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400'}`}>Nuovo</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight">Post-2023</span>
              </button>

              <button 
                  onClick={() => handleChange('frontierWorkerType', 'OLD')}
                  className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center text-center gap-1 ${inputs.frontierWorkerType === 'OLD' ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/30' : 'border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-200 dark:hover:border-slate-600'}`}
              >
                   {inputs.frontierWorkerType === 'OLD' && <div className="absolute top-2 right-2"><Check size={14} className="text-emerald-600 dark:text-emerald-400" /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'OLD' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-400'}`}>Vecchio</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight">Ante-2023</span>
              </button>
           </div>

           {inputs.frontierWorkerType === 'NEW' && (
              <div className="mt-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700">
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase block mb-2">Distanza Confine</span>
                  <div className="flex gap-2">
                    {['WITHIN_20KM', 'OVER_20KM'].map(zone => (
                        <button 
                            key={zone}
                            onClick={() => handleChange('distanceZone', zone)}
                            className={`flex-1 py-2 text-[10px] font-bold rounded-lg border transition-all ${inputs.distanceZone === zone ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-200 dark:shadow-none' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                        >
                            {zone === 'WITHIN_20KM' ? 'Entro 20km' : 'Oltre 20km'}
                        </button>
                    ))}
                  </div>
              </div>
           )}
        </div>

        {/* SECTION 4: AVANZATE - Card */}
        <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm transition-all hover:shadow-md">
            <button 
             onClick={() => toggleSection('advanced')}
             className="w-full flex items-center justify-between text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
           >
              <div className="flex items-center gap-2">
                 <Joystick size={14} className="text-violet-500" />
                 <span className="text-xs font-bold uppercase tracking-wider">Avanzate</span>
              </div>
              {openSections.advanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
           </button>
           
           <div className={`space-y-4 overflow-hidden transition-all duration-300 ${openSections.advanced ? 'max-h-[600px] mt-4 opacity-100' : 'max-h-0 opacity-0'}`}>
              
              <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                      {loadingRate ? <Loader2 size={10} className="animate-spin text-yellow-500" /> : <Coins size={10} className="text-yellow-500" />} Cambio EUR/CHF
                    </label>
                    <input 
                      type="number" step="0.001" value={inputs.customExchangeRate}
                      onChange={(e) => handleChange('customExchangeRate', Number(e.target.value))}
                      className="w-full h-9 bg-slate-50 dark:bg-slate-900 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-200 outline-none focus:border-yellow-400"
                    />
                 </div>
                 <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1"><CalendarClock size={10} className="text-cyan-500" /> Mensilità</label>
                    <div className="flex h-9 items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                       <button onClick={() => decrement('monthsBasis')} className="w-8 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors border-r border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0">
                          <Minus size={14} />
                       </button>
                       <input 
                         type="number" 
                         value={inputs.monthsBasis} 
                         readOnly 
                         className="flex-1 min-w-0 h-full bg-transparent text-center font-bold text-xs text-slate-700 dark:text-slate-200 outline-none m-0" 
                       />
                       <button onClick={() => increment('monthsBasis')} className="w-8 h-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors border-l border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0">
                          <Plus size={14} />
                       </button>
                    </div>
                 </div>
              </div>

              <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1"><Hourglass size={10} className="text-amber-700 dark:text-amber-500" /> Età ({inputs.age})</label>
                  <input 
                    type="range" min="18" max="70" value={inputs.age}
                    onChange={(e) => handleChange('age', Number(e.target.value))}
                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none accent-violet-600"
                  />
              </div>

              <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1"><HeartHandshake size={10} className="text-rose-500" /> Stato Civile</label>
                      <select value={inputs.maritalStatus} onChange={(e) => handleChange('maritalStatus', e.target.value)} className="w-full h-9 bg-slate-50 dark:bg-slate-900 px-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-200 outline-none focus:border-rose-400">
                        <option value="SINGLE">Single</option>
                        <option value="MARRIED">Sposato/a</option>
                        <option value="DIVORCED">Divorziato/a</option>
                        <option value="WIDOWED">Vedovo/a</option>
                      </select>
                  </div>
                  <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1"><VenetianMask size={10} className="text-purple-500" /> Sesso</label>
                      <div className="flex h-9 bg-slate-50 dark:bg-slate-900 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
                        <button onClick={() => handleChange('sex', 'M')} className={`flex-1 h-full rounded-md text-[10px] font-bold flex items-center justify-center transition-colors ${inputs.sex === 'M' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}>M</button>
                        <button onClick={() => handleChange('sex', 'F')} className={`flex-1 h-full rounded-md text-[10px] font-bold flex items-center justify-center transition-colors ${inputs.sex === 'F' ? 'bg-pink-500 text-white shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}>F</button>
                      </div>
                  </div>
              </div>

               {/* SPOUSE WORKS TOGGLE - Only for Married */}
               {inputs.maritalStatus === 'MARRIED' && (
                <div className="p-3 bg-rose-50 dark:bg-rose-900/20 rounded-xl border border-rose-100 dark:border-rose-800 transition-all animate-fade-in">
                    <label className="flex items-center justify-between cursor-pointer">
                       <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300 uppercase flex items-center gap-2">
                           <Briefcase size={12} /> Il coniuge lavora?
                       </span>
                       <div className="relative">
                          <input 
                            type="checkbox" 
                            checked={inputs.spouseWorks}
                            onChange={(e) => handleChange('spouseWorks', e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-rose-500"></div>
                       </div>
                    </label>
                    <p className="text-[9px] text-rose-500/80 mt-1 dark:text-rose-400/80 leading-tight">
                        {inputs.spouseWorks ? 'Doppio reddito (Tabella C)' : 'Reddito unico (Tabella B)'}
                    </p>
                </div>
               )}

           </div>
        </div>

      </div>
    </div>
  );
};