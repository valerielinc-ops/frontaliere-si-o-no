import React, { useEffect, useState } from 'react';
import { Wand2, Castle, Bandage, PiggyBank, CalendarClock, Joystick, Plus, Minus, ChevronDown, ChevronUp, Check, TrainFront, Coins, Receipt, Car, Home, User, Heart, Briefcase, Ruler, Baby, Users, Sliders, Calculator, PersonStanding, RotateCcw, Settings2, RefreshCw, X, Zap, Wifi, ShoppingBasket, Bus, Fuel, Info } from 'lucide-react';
import { SimulationInputs, ExpenseItem } from '../types';
import { DEFAULT_INPUTS, DEFAULT_TECH_PARAMS, PRESET_EXPENSES_CH, PRESET_EXPENSES_IT } from '../constants';

interface Props {
  inputs: SimulationInputs;
  setInputs: React.Dispatch<React.SetStateAction<SimulationInputs>>;
  onCalculate: () => void; 
  isFocusMode?: boolean;
}

// --- Icons Map for Dynamic Rendering ---
const IconsMap: Record<string, any> = {
  Home, ShoppingBasket, Wifi, Zap, Bus, Car, Fuel
};

// --- Reusable Components ---

const InfoTooltip = ({ text }: { text: string }) => (
  <div className="group relative inline-flex items-center ml-1.5 cursor-help z-50">
    <Info size={12} className="text-slate-400 hover:text-indigo-500 transition-colors" />
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 dark:bg-slate-700 text-white text-[10px] font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 pointer-events-none animate-fade-in text-center">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
    </div>
  </div>
);

const SectionHeader = ({ title, icon: Icon, isOpen, onToggle, subtext, iconColor = "text-indigo-600", action }: any) => (
  <button 
    onClick={onToggle} 
    className={`w-full flex items-center justify-between p-4 rounded-xl transition-all duration-300 group ${isOpen ? 'bg-white dark:bg-slate-800 shadow-sm' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
  >
    <div className="flex items-center gap-3">
      <div className={`p-2 rounded-lg transition-colors ${isOpen ? `bg-opacity-20 ${iconColor.replace('text-', 'bg-')} ${iconColor}` : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 group-hover:bg-white dark:group-hover:bg-slate-700'}`}>
        <Icon size={18} />
      </div>
      <div className="text-left">
        <div className={`text-sm font-bold transition-colors ${isOpen ? 'text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-400'}`}>{title}</div>
        {subtext && <div className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">{subtext}</div>}
      </div>
    </div>
    <div className="flex items-center gap-2">
      {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
      <div className={`transition-transform duration-300 ${isOpen ? 'rotate-180 text-indigo-500' : 'text-slate-400'}`}>
        <ChevronDown size={18} />
      </div>
    </div>
  </button>
);

const StepperInput = ({ value, onChange, min = 0, max, label, icon: Icon, iconColor = "text-slate-400", tooltip }: any) => (
  <div className="space-y-2">
    {label && <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">{Icon && <Icon size={12} className={iconColor}/>} {label} {tooltip && <InfoTooltip text={tooltip} />}</label>}
    <div className="flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-11 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-all">
      <button 
        onClick={() => onChange(Math.max(min, value - 1))}
        className="w-12 h-full flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all border-r border-slate-100 dark:border-slate-800"
      >
        <Minus size={16} strokeWidth={2.5} />
      </button>
      <div className="flex-1 h-full relative flex items-center justify-center bg-white/50 dark:bg-slate-900/50">
        <input 
          type="number" 
          value={value} 
          onChange={(e) => onChange(parseInt(e.target.value) || min)}
          className="w-full h-full bg-transparent text-center font-bold text-base text-slate-700 dark:text-slate-200 outline-none appearance-none p-0"
        />
      </div>
      <button 
        onClick={() => onChange(max ? Math.min(max, value + 1) : value + 1)}
        className="w-12 h-full flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all border-l border-slate-100 dark:border-slate-800"
      >
        <Plus size={16} strokeWidth={2.5} />
      </button>
    </div>
  </div>
);

const SegmentControl = ({ options, value, onChange, label, icon: Icon, iconColor = "text-slate-400", tooltip }: any) => (
  <div className="space-y-2">
    {label && <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">{Icon && <Icon size={12} className={iconColor}/>} {label} {tooltip && <InfoTooltip text={tooltip} />}</label>}
    <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl relative h-11">
      {options.map((opt: any) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 flex items-center justify-center text-[11px] font-bold rounded-lg transition-all duration-300 relative z-10 ${value === opt.value ? 'text-indigo-600 dark:text-indigo-300 bg-white dark:bg-slate-800 shadow-sm scale-[0.98]' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);

// TechInput extracted OUTSIDE the main component to prevent re-rendering/focus loss
const TechInput: React.FC<{ 
  label: string; 
  value: number; 
  onChange: (val: number) => void; 
  step?: string; 
  suffix?: string; 
  isPercentage?: boolean;
}> = ({ label, value, onChange, step = "0.01", suffix = "", isPercentage = false }) => {
  const displayValue = isPercentage ? parseFloat((value * 100).toFixed(3)) : value;

  return (
      <div className="space-y-2">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wide h-4 flex items-end">{label}</label>
        <div className="relative group">
            <input 
              type="number" 
              step={step} 
              value={displayValue}
              onChange={(e) => {
                  let val = parseFloat(e.target.value);
                  if (isNaN(val)) val = 0;
                  onChange(isPercentage ? val / 100 : val);
              }}
              className="w-full h-11 bg-white dark:bg-slate-900 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all"
            />
            {suffix && <span className="absolute right-3 top-3.5 text-xs font-bold text-slate-400 pointer-events-none">{suffix}</span>}
        </div>
      </div>
  );
};

export const InputCard: React.FC<Props> = ({ inputs, setInputs }) => {
  const [loadingRate, setLoadingRate] = useState(false);
  const [lastRateUpdate, setLastRateUpdate] = useState<Date | null>(null);
  const [showPresets, setShowPresets] = useState<'CH' | 'IT' | null>(null);
  
  const [openSections, setOpenSections] = useState({
    general: true,
    expenses: false,
    settings: false, 
    rates: false
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections(prev => ({...prev, [key]: !prev[key]}));
  };

  const handleChange = (field: keyof SimulationInputs, value: any) => {
    setInputs(prev => ({ ...prev, [field]: value }));
  };

  const handleReset = () => setInputs(DEFAULT_INPUTS);
  
  const handleResetTech = () => {
    setInputs(prev => ({...prev, ...DEFAULT_TECH_PARAMS}));
  };

  const fetchRate = async () => {
    setLoadingRate(true);
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=CHF&to=EUR');
      const data = await res.json();
      if (data?.rates?.EUR) {
        handleChange('customExchangeRate', data.rates.EUR);
        setLastRateUpdate(new Date());
      }
    } catch (e) {
      console.error("Failed rate fetch", e);
    } finally {
      setLoadingRate(false);
    }
  };

  useEffect(() => {
    fetchRate();
    const interval = setInterval(fetchRate, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatNumber = (val: number) => val === 0 ? '' : val.toLocaleString('it-IT');
  const parseNumber = (val: string) => {
    const clean = val.replace(/\./g, '').replace(/[^0-9]/g, '');
    return clean === '' ? 0 : parseInt(clean, 10);
  };

  // --- Expenses Logic ---
  const updateExpense = (target: 'CH' | 'IT', id: string, updates: Partial<ExpenseItem>) => {
    const field = target === 'CH' ? 'expensesCH' : 'expensesIT';
    setInputs(prev => ({
      ...prev,
      [field]: prev[field as 'expensesCH' | 'expensesIT'].map(e => e.id === id ? { ...e, ...updates } : e)
    }));
  };

  const addExpense = (target: 'CH' | 'IT', preset?: {label: string, amount: number}) => {
    const newItem: ExpenseItem = { 
        id: Math.random().toString(36).substr(2, 9), 
        label: preset ? preset.label : 'Nuova spesa', 
        amount: preset ? preset.amount : 0, 
        frequency: 'MONTHLY' 
    };
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: [...prev[target === 'CH' ? 'expensesCH' : 'expensesIT'], newItem] }));
    setShowPresets(null); // Close presets after adding
  };

  const removeExpense = (target: 'CH' | 'IT', id: string) => {
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: prev[target === 'CH' ? 'expensesCH' : 'expensesIT'].filter(e => e.id !== id) }));
  };

  return (
    <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-[2rem] shadow-xl border border-white/60 dark:border-slate-800 h-full flex flex-col overflow-hidden transition-all duration-300">
      {/* Header */}
      <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm z-10">
        <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-xl shadow-lg shadow-indigo-500/20">
              <Wand2 size={20} />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-800 dark:text-slate-100 tracking-tight">Parametri</h2>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider">Configurazione</p>
            </div>
        </div>
        <button onClick={handleReset} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-all" title="Resetta Tutto">
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-3 pb-20">
        
        {/* SECTION 1: MAIN INPUTS */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm">
           <div className="p-5 space-y-6">
              {/* Income Input - Prominent */}
              <div className="space-y-2">
                 <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                   <Coins size={14} className="text-amber-500"/> Reddito Lordo Annuo 
                   <InfoTooltip text="Inserisci il reddito lordo da contratto, inclusa eventuale 13esima (es. 6000 * 13 = 78000)." />
                 </label>
                 <div className="relative group transition-transform duration-200 focus-within:scale-[1.01]">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <span className="text-slate-400 font-bold text-lg">CHF</span>
                    </div>
                    <input 
                      type="text" 
                      inputMode="numeric" 
                      value={formatNumber(inputs.annualIncomeCHF)} 
                      onChange={(e) => handleChange('annualIncomeCHF', parseNumber(e.target.value))} 
                      className="w-full pl-14 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-700 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-bold text-slate-800 dark:text-slate-100 text-2xl tracking-tight" 
                      placeholder="0"
                    />
                 </div>
              </div>

              {/* Demographics Grid */}
              <div className="grid grid-cols-2 gap-4">
                 <StepperInput label="Età" value={inputs.age} onChange={(v: number) => handleChange('age', v)} min={18} max={99} icon={User} iconColor="text-blue-500" tooltip="L'età influenza i contributi pensionistici LPP (Pilastro 2)." />
                 <SegmentControl 
                    label="Sesso" 
                    icon={PersonStanding}
                    iconColor="text-pink-500"
                    options={[{label: 'Uomo', value: 'M'}, {label: 'Donna', value: 'F'}]} 
                    value={inputs.sex} 
                    onChange={(v: any) => handleChange('sex', v)} 
                 />
              </div>

              {/* Marital Status */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">
                  <Heart size={12} className="text-rose-500"/> Stato Civile
                  <InfoTooltip text="Lo stato civile determina la tabella fiscale applicata in Svizzera (A, B, C o H)." />
                </label>
                <div className="relative">
                  <select 
                    value={inputs.maritalStatus} 
                    onChange={(e) => handleChange('maritalStatus', e.target.value)}
                    className="w-full h-11 pl-3 pr-8 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold uppercase appearance-none outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 transition-all cursor-pointer text-slate-700 dark:text-slate-200"
                  >
                    <option value="SINGLE">Celibe/Nubile</option>
                    <option value="MARRIED">Sposato/a</option>
                    <option value="DIVORCED">Divorziato/a</option>
                    <option value="WIDOWED">Vedovo/a</option>
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-3.5 text-slate-400 pointer-events-none"/>
                </div>
              </div>

              {/* Spouse Works Toggle */}
              {inputs.maritalStatus === 'MARRIED' && (
                 <div className="flex items-center justify-between bg-indigo-50/50 dark:bg-indigo-900/10 p-3 rounded-xl border border-indigo-100 dark:border-indigo-900/30 animate-fade-in mt-2">
                    <span className="text-[10px] font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5">
                      <Briefcase size={14} className="text-indigo-500"/> Coniuge lavora?
                      <InfoTooltip text="Se il coniuge lavora, si applica la Tabella C (Doppio Reddito) con aliquote diverse." />
                    </span>
                    <button 
                      onClick={() => handleChange('spouseWorks', !inputs.spouseWorks)}
                      className={`relative w-11 h-6 rounded-full transition-all duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${inputs.spouseWorks ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                    >
                      <span className={`block w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] mt-1 ml-1 ${inputs.spouseWorks ? 'translate-x-5' : 'translate-x-0'}`}/>
                    </button>
                 </div>
              )}
           </div>
        </div>

        {/* SECTION 2: FRONTIER TYPE */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-4">
           <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
             <TrainFront size={14} className="text-emerald-500"/> Tipologia Frontaliere
             <InfoTooltip text="Definisce il regime fiscale. 'Vecchio' (prima 2023) paga solo in CH. 'Nuovo' paga in CH e IT." />
           </h3>
           
           <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); }} 
                className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'NEW' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-slate-300'}`}
              >
                  {inputs.frontierWorkerType === 'NEW' && <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'NEW' ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400'}`}>Nuovo</span>
                  <span className="text-[9px] text-slate-400 font-medium">Post 17.07.2023</span>
              </button>
              <button 
                onClick={() => handleChange('frontierWorkerType', 'OLD')} 
                className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'OLD' ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20' : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-slate-300'}`}
              >
                   {inputs.frontierWorkerType === 'OLD' && <div className="absolute top-2 right-2 bg-emerald-500 text-white rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'OLD' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-400'}`}>Vecchio</span>
                  <span className="text-[9px] text-slate-400 font-medium">Pre 17.07.2023</span>
              </button>
           </div>
           
           {inputs.frontierWorkerType === 'NEW' && (
              <div className="pt-2 animate-fade-in">
                <SegmentControl 
                    label="Fascia di Confine" 
                    icon={Ruler}
                    iconColor="text-orange-500"
                    tooltip="Entro 20km: Franchigia 10k e aliquota CH max 80%. Oltre 20km: Regime ordinario."
                    options={[{label: 'Entro 20km', value: 'WITHIN_20KM'}, {label: 'Oltre 20km', value: 'OVER_20KM'}]} 
                    value={inputs.distanceZone} 
                    onChange={(v: any) => handleChange('distanceZone', v)} 
                 />
              </div>
           )}
        </div>

        {/* SECTION 3: FAMILY & INSURANCE */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-5">
           <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2"><Castle size={14} className="text-purple-500"/> Famiglia & Salute</h3>
           
           <div className="grid grid-cols-2 gap-4">
              <StepperInput label="Membri Nucleo" value={inputs.familyMembers} onChange={(v: number) => handleChange('familyMembers', v)} min={1} icon={Users} iconColor="text-cyan-500" />
              <StepperInput label="Figli a Carico" value={inputs.children} onChange={(v: number) => handleChange('children', v)} min={0} icon={Baby} iconColor="text-pink-500" tooltip="Numero figli minorenni per assegni familiari e deduzioni." />
           </div>

           <div className="space-y-2">
               <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">
                 <Bandage size={12} className="text-rose-500"/> Cassa Malati (Mese)
                 <InfoTooltip text="Premio mensile per l'assicurazione sanitaria obbligatoria (LAMal) in Svizzera." />
               </label>
               <div className="relative group">
                   <input type="number" value={inputs.healthInsuranceCHF || ''} onChange={(e) => handleChange('healthInsuranceCHF', Number(e.target.value))} className="w-full pl-3 pr-10 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-all font-bold text-slate-800 dark:text-slate-100 text-sm h-11" placeholder="0" />
                   <span className="absolute right-3 top-3.5 text-slate-400 dark:text-slate-500 font-bold text-xs">CHF</span>
               </div>
           </div>
        </div>

        {/* SECTION 4: EXPENSES (COLLAPSIBLE) */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader title="Spese Fisse Personali" icon={Receipt} isOpen={openSections.expenses} onToggle={() => toggleSection('expenses')} iconColor="text-teal-500" />
           
           {openSections.expenses && (
             <div className="p-5 pt-0 space-y-6 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                {/* Switzerland Expenses */}
                <div className="space-y-3">
                   <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-blue-500 uppercase"><Home size={12}/> Vivere in CH</div>
                      <button onClick={() => setShowPresets(showPresets === 'CH' ? null : 'CH')} className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 text-[10px] font-bold uppercase ${showPresets === 'CH' ? 'bg-blue-100 text-blue-700' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 hover:bg-blue-100'}`}>
                         <Plus size={14}/> {showPresets === 'CH' ? 'Chiudi' : 'Aggiungi'}
                      </button>
                   </div>
                   
                   {/* Smart Presets Area for CH */}
                   {showPresets === 'CH' && (
                     <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 mb-2 animate-fade-in">
                        <p className="text-[10px] text-slate-400 uppercase font-bold mb-2">Suggerimenti Rapidi:</p>
                        <div className="flex flex-wrap gap-2">
                           <button onClick={() => addExpense('CH')} className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-bold text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors">Vuota</button>
                           {PRESET_EXPENSES_CH.map((preset, idx) => {
                             const Icon = IconsMap[preset.icon] || Home;
                             return (
                               <button 
                                 key={idx}
                                 onClick={() => addExpense('CH', preset)}
                                 className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-400 hover:border-blue-400 hover:text-blue-500 transition-colors flex items-center gap-1.5"
                               >
                                  <Icon size={10} />
                                  {preset.label}
                               </button>
                             )
                           })}
                        </div>
                     </div>
                   )}

                   <div className="space-y-2">
                     {inputs.expensesCH.map(exp => (
                        <div key={exp.id} className="flex gap-2 items-center group/exp animate-fade-in">
                          <input type="text" value={exp.label} onChange={e => updateExpense('CH', exp.id, { label: e.target.value })} className="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-[10px] font-bold outline-none focus:border-indigo-500 transition-colors" />
                          <input type="number" value={exp.amount || ''} onChange={e => updateExpense('CH', exp.id, { amount: Number(e.target.value) })} placeholder="0" className="w-16 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-[10px] font-mono font-bold outline-none focus:border-indigo-500 text-right transition-colors" />
                          <button onClick={() => updateExpense('CH', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-2 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-[9px] font-bold uppercase text-slate-500 w-12 text-center hover:bg-slate-200 transition-colors">{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
                          <button onClick={() => removeExpense('CH', exp.id)} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><X size={14}/></button>
                        </div>
                     ))}
                     {inputs.expensesCH.length === 0 && !showPresets && <div className="text-[10px] text-slate-400 italic text-center py-4 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">Nessuna spesa aggiunta</div>}
                   </div>
                </div>
                
                {/* Italy Expenses */}
                <div className="space-y-3">
                   <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-red-500 uppercase"><Car size={12}/> Vivere in IT</div>
                      <button onClick={() => setShowPresets(showPresets === 'IT' ? null : 'IT')} className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 text-[10px] font-bold uppercase ${showPresets === 'IT' ? 'bg-red-100 text-red-700' : 'bg-red-50 dark:bg-red-900/30 text-red-600 hover:bg-red-100'}`}>
                         <Plus size={14}/> {showPresets === 'IT' ? 'Chiudi' : 'Aggiungi'}
                      </button>
                   </div>

                    {/* Smart Presets Area for IT */}
                   {showPresets === 'IT' && (
                     <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 mb-2 animate-fade-in">
                        <p className="text-[10px] text-slate-400 uppercase font-bold mb-2">Suggerimenti Rapidi:</p>
                        <div className="flex flex-wrap gap-2">
                           <button onClick={() => addExpense('IT')} className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-bold text-slate-500 hover:border-red-400 hover:text-red-500 transition-colors">Vuota</button>
                           {PRESET_EXPENSES_IT.map((preset, idx) => {
                             const Icon = IconsMap[preset.icon] || Home;
                             return (
                               <button 
                                 key={idx}
                                 onClick={() => addExpense('IT', preset)}
                                 className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-400 hover:border-red-400 hover:text-red-500 transition-colors flex items-center gap-1.5"
                               >
                                  <Icon size={10} />
                                  {preset.label}
                               </button>
                             )
                           })}
                        </div>
                     </div>
                   )}

                   <div className="space-y-2">
                     {inputs.expensesIT.map(exp => (
                        <div key={exp.id} className="flex gap-2 items-center group/exp animate-fade-in">
                          <input type="text" value={exp.label} onChange={e => updateExpense('IT', exp.id, { label: e.target.value })} className="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-[10px] font-bold outline-none focus:border-indigo-500 transition-colors" />
                          <input type="number" value={exp.amount || ''} onChange={e => updateExpense('IT', exp.id, { amount: Number(e.target.value) })} placeholder="0" className="w-16 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-[10px] font-mono font-bold outline-none focus:border-indigo-500 text-right transition-colors" />
                          <button onClick={() => updateExpense('IT', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-2 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-[9px] font-bold uppercase text-slate-500 w-12 text-center hover:bg-slate-200 transition-colors">{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
                          <button onClick={() => removeExpense('IT', exp.id)} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><X size={14}/></button>
                        </div>
                     ))}
                      {inputs.expensesIT.length === 0 && !showPresets && <div className="text-[10px] text-slate-400 italic text-center py-4 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">Nessuna spesa aggiunta</div>}
                   </div>
                </div>
             </div>
           )}
        </div>

        {/* SECTION 5: OPTIONS */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader title="Opzioni di Calcolo" icon={Settings2} isOpen={openSections.settings} onToggle={() => toggleSection('settings')} subtext="Cambio & Mensilità" iconColor="text-gray-500" />
           
           {openSections.settings && (
              <div className="p-5 pt-0 space-y-5 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                  <div className="grid grid-cols-2 gap-4 items-end">
                     <div className="space-y-2">
                        <div className="flex justify-between items-center h-4">
                            <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1">
                                <Coins size={10} className="text-yellow-500" /> Cambio EUR/CHF
                                <InfoTooltip text="Tasso usato per convertire lo stipendio in Euro per il calcolo delle tasse italiane." />
                            </label>
                            <button onClick={fetchRate} disabled={loadingRate} className={`text-[9px] flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 hover:text-indigo-500 font-bold transition-all ${loadingRate ? 'opacity-50' : ''}`}>
                                <RefreshCw size={8} className={loadingRate ? 'animate-spin' : ''} /> {lastRateUpdate ? 'Live' : 'Aggiorna'}
                            </button>
                        </div>
                        <input 
                           type="number" 
                           step="0.001" 
                           value={inputs.customExchangeRate} 
                           onChange={(e) => handleChange('customExchangeRate', Number(e.target.value))} 
                           className="w-full h-11 bg-slate-50 dark:bg-slate-900 px-3 rounded-xl border border-slate-200 dark:border-slate-700 outline-none text-base font-bold focus:border-indigo-500 transition-colors" 
                        />
                     </div>
                     <StepperInput label="Mensilità" value={inputs.monthsBasis} onChange={(v: number) => handleChange('monthsBasis', v)} min={12} max={15} icon={CalendarClock} iconColor="text-orange-400" tooltip="Numero di mensilità (es. 13) per calcolare il netto mensile corretto." />
                  </div>
              </div>
           )}
        </div>

        {/* SECTION 6: TECHNICAL PARAMETERS (Now Top-Level) */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader 
             title="Parametri Tecnici" 
             icon={Sliders} 
             isOpen={openSections.rates} 
             onToggle={() => toggleSection('rates')} 
             subtext="Aliquote & Coefficienti" 
             iconColor="text-cyan-600"
             action={
               openSections.rates && (
                 <button onClick={handleResetTech} className="text-[9px] font-bold text-slate-400 hover:text-red-500 bg-slate-100 dark:bg-slate-900/50 px-2 py-1 rounded transition-colors" title="Ripristina valori default">
                    Reset
                 </button>
               )
             }
           />
           
           {openSections.rates && (
              <div className="p-5 pt-0 space-y-4 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-[10px] font-bold uppercase text-slate-400">Aliquote Svizzera (%)</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label="AVS/AI/IPG" value={inputs.avsRate} onChange={(v) => handleChange('avsRate', v)} isPercentage step="0.1" />
                          <TechInput label="AC (Disocc.)" value={inputs.acRate} onChange={(v) => handleChange('acRate', v)} isPercentage step="0.1" />
                          <TechInput label="LAA (Infortuni)" value={inputs.laaRate} onChange={(v) => handleChange('laaRate', v)} isPercentage step="0.1" />
                          <TechInput label="IJM (Malattia)" value={inputs.ijmRate} onChange={(v) => handleChange('ijmRate', v)} isPercentage step="0.1" />
                      </div>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-[10px] font-bold uppercase text-slate-400">LPP (Pensione %)</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label="25-34 anni" value={inputs.lppRate25_34} onChange={(v) => handleChange('lppRate25_34', v)} isPercentage step="0.1" />
                          <TechInput label="35-44 anni" value={inputs.lppRate35_44} onChange={(v) => handleChange('lppRate35_44', v)} isPercentage step="0.1" />
                          <TechInput label="45-54 anni" value={inputs.lppRate45_54} onChange={(v) => handleChange('lppRate45_54', v)} isPercentage step="0.1" />
                          <TechInput label="55+ anni" value={inputs.lppRate55_plus} onChange={(v) => handleChange('lppRate55_plus', v)} isPercentage step="0.1" />
                      </div>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-[10px] font-bold uppercase text-slate-400">Italia</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label="Addizionali %" value={inputs.itAddizionaleRate} onChange={(v) => handleChange('itAddizionaleRate', v)} isPercentage step="0.1" />
                          <TechInput label="Deduzione Lav. (€)" value={inputs.itWorkDeduction} onChange={(v) => handleChange('itWorkDeduction', v)} step="10" />
                      </div>
                  </div>
              </div>
           )}
        </div>

      </div>
    </div>
  );
};