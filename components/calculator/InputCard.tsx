import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import { Wand2, Castle, Bandage, PiggyBank, CalendarClock, Joystick, Plus, Minus, ChevronDown, ChevronUp, Check, TrainFront, Coins, Receipt, Car, Home, User, Heart, Briefcase, Ruler, Baby, Users, Sliders, Calculator, RotateCcw, Settings2, RefreshCw, X, Zap, Wifi, ShoppingBasket, Bus, Fuel, Info, Smartphone, Droplet, Tv, Shield, Landmark, AlertTriangle } from 'lucide-react';
import { SimulationInputs, ExpenseItem } from '../../types';
import { DEFAULT_INPUTS, DEFAULT_TECH_PARAMS, PRESET_EXPENSES_CH, PRESET_EXPENSES_IT, calculateDynamicExpenses } from '../../constants';
import { Analytics } from '../../services/analytics';
import { useTranslation } from '../../services/i18n';
import { useNavigationOptional } from '@/services/NavigationContext';
import { reportCaughtError } from '@/services/errorReporter';
// exchangeRateService is lazy-loaded to reduce main bundle size

interface Props {
  inputs: SimulationInputs;
  setInputs: React.Dispatch<React.SetStateAction<SimulationInputs>>;
  onCalculate: () => void; 
  focusField?: 'age' | 'maritalStatus' | 'children' | null;
  focusRequestId?: number;
}

// --- Icons Map for Dynamic Rendering ---
const IconsMap: Record<string, any> = {
  Home, ShoppingBasket, Wifi, Zap, Bus, Car, Fuel, Smartphone, Droplet, Tv
};

// --- Reusable Components ---

const InfoTooltip = ({ text }: { text: string }) => (
  <div className="group relative inline-flex items-center ml-1.5 cursor-help z-50">
    <Info size={12} className="text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors" />
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 dark:bg-slate-700 text-white text-xs font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 pointer-events-none animate-fade-in text-center">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
    </div>
  </div>
);

const iconBgMap: Record<string, string> = {
  'text-indigo-600': 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600',
  'text-blue-500': 'bg-blue-100 dark:bg-blue-900/30 text-blue-500',
  'text-gray-500': 'bg-slate-100 dark:bg-slate-900/30 text-slate-500 dark:text-slate-400',
  'text-orange-500': 'bg-orange-100 dark:bg-orange-900/30 text-orange-500',
  'text-amber-700': 'bg-amber-100 dark:bg-amber-900/30 text-amber-700',
  'text-blue-600': 'bg-blue-100 dark:bg-blue-900/30 text-blue-600',
};

const SectionHeader = ({ title, icon: Icon, isOpen, onToggle, subtext, iconColor = "text-indigo-600", action, sectionId }: any) => (
  <div
    onClick={onToggle}
    role="button"
    tabIndex={0}
    aria-expanded={isOpen}
    aria-controls={sectionId}
    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    className={`w-full flex items-center justify-between p-4 rounded-xl transition-[color,background-color,box-shadow] duration-300 group cursor-pointer ${isOpen ? 'bg-white dark:bg-slate-800 shadow-sm' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
  >
    <div className="flex items-center gap-3">
      <div className={`p-2 rounded-lg transition-colors ${isOpen ? (iconBgMap[iconColor] ?? `bg-slate-100 dark:bg-slate-700 ${iconColor}`) : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 group-hover:bg-white dark:group-hover:bg-slate-700'}`}>
        <Icon size={18} />
      </div>
      <div className="text-left">
        <div className={`text-sm font-bold transition-colors ${isOpen ? 'text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>{title}</div>
        {subtext && <div className="text-xs text-slate-600 dark:text-slate-400 font-medium uppercase tracking-wide">{subtext}</div>}
      </div>
    </div>
    <div className="flex items-center gap-2">
      {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
      <div className={`transition-transform duration-300 ${isOpen ? 'rotate-180 text-indigo-600' : 'text-slate-500'}`}>
        <ChevronDown size={18} />
      </div>
    </div>
  </div>
);

const StepperInput = ({ value, onChange, min = 0, max, label, icon: Icon, iconColor = "text-slate-500 dark:text-slate-400", tooltip, inputId }: any) => (
  <div className="space-y-2 min-w-0">
    {label && <label htmlFor={inputId} className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5 h-4 truncate">{Icon && <Icon size={12} className={`${iconColor} shrink-0`}/>} <span className="truncate">{label}</span> {tooltip && <InfoTooltip text={tooltip} />}</label>}
    <div className="flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-12 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-[color,border-color,box-shadow]">
      <button 
        onClick={() => onChange(Math.max(min, value - 1))}
        className="w-10 shrink-0 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-[color,background-color,transform] border-r border-slate-100 dark:border-slate-800"
        aria-label={`${label || 'Valore'}: diminuisci`}
        type="button"
      >
        <Minus size={16} strokeWidth={2.5} />
      </button>
      <div className="flex-1 min-w-[40px] h-full relative flex items-center justify-center bg-white/50 dark:bg-slate-900/50">
        <input 
          id={inputId}
          type="number" 
          value={value} 
          onChange={(e) => {
            let v = parseInt(e.target.value);
            if (isNaN(v)) v = min;
            v = Math.max(min, v);
            if (max !== undefined) v = Math.min(max, v);
            onChange(v);
          }}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); onChange(max !== undefined ? Math.min(value + 1, max) : value + 1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(value - 1, min)); }
          }}
          min={min}
          max={max}
          className="w-full h-full min-h-[48px] bg-transparent text-center font-bold text-base text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-blue-500 appearance-none px-1 py-3"
          aria-label={label || 'Valore numerico'}
        />
      </div>
      <button 
        onClick={() => onChange(max ? Math.min(max, value + 1) : value + 1)}
        className="w-10 shrink-0 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-[color,background-color,transform] border-l border-slate-100 dark:border-slate-800"
        aria-label={`${label || 'Valore'}: aumenta`}
        type="button"
      >
        <Plus size={16} strokeWidth={2.5} />
      </button>
    </div>
  </div>
);

const SegmentControl = ({ options, value, onChange, label, icon: Icon, iconColor = "text-slate-500 dark:text-slate-400", tooltip }: any) => (
  <div className="space-y-2">
    {label && <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5 h-4">{Icon && <Icon size={12} className={iconColor}/>} {label} {tooltip && <InfoTooltip text={tooltip} />}</label>}
    <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl relative h-11" role="group">
      {options.map((opt: any) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`flex-1 flex items-center justify-center text-xs font-bold rounded-lg transition-[color,background-color,box-shadow,transform] duration-300 relative z-10 ${value === opt.value ? 'text-indigo-600 dark:text-indigo-300 bg-white dark:bg-slate-800 shadow-sm scale-[0.98]' : 'text-slate-600 dark:text-slate-400 hover:text-slate-700'}`}
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
        <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide h-4 flex items-end">{label}</label>
        <div className="relative group">
            <input
              type="number"
              inputMode="decimal"
              step={step}
              value={displayValue}
              onChange={(e) => {
                  let val = parseFloat(e.target.value);
                  if (isNaN(val)) val = 0;
                  onChange(isPercentage ? val / 100 : val);
              }}
              aria-label={label}
              className="w-full h-11 bg-white dark:bg-slate-900 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-[color,border-color,box-shadow]"
            />
            {suffix && <span className="absolute right-3 top-3.5 text-xs font-bold text-slate-600 dark:text-slate-300 pointer-events-none">{suffix}</span>}
        </div>
      </div>
  );
};

const SALARY_MIN = 0;
const SALARY_MAX = 1_000_000;

const InputCardBase: React.FC<Props> = ({ inputs, setInputs, onCalculate, focusField = null, focusRequestId = 0 }) => {
  const { t } = useTranslation();
  const nav = useNavigationOptional();
  const isFocusMode = nav?.isFocusMode;
  const [loadingRate, setLoadingRate] = useState(false);
  const [lastRateUpdate, setLastRateUpdate] = useState<Date | null>(null);
  const [showPresets, setShowPresets] = useState<'CH' | 'IT' | null>(null);
  const [salaryError, setSalaryError] = useState<string | null>(null);
  const [easterEgg, setEasterEgg] = useState<string | null>(null);
  const [easterEggVisible, setEasterEggVisible] = useState(false);
  const easterEggTimer = useRef<ReturnType<typeof setTimeout>>();
  const inputStartTracked = useRef(false);

  // Sync easter egg toast with popup queue so it doesn't overlap gamification
  useEffect(() => {
    if (!easterEgg) return;
    requestSlot('easter-egg-inputcard', POPUP_PRIORITY.EASTER_EGG_TOAST);
    setEasterEggVisible(isActive('easter-egg-inputcard'));
    const unsub = subscribe(() => setEasterEggVisible(isActive('easter-egg-inputcard')));
    const autoHide = setTimeout(() => {
      setEasterEgg(null);
      releaseSlot('easter-egg-inputcard');
    }, 3500);
    return () => { unsub(); clearTimeout(autoHide); };
  }, [easterEgg]);

  const dismissEasterEgg = useCallback(() => {
    setEasterEgg(null);
    releaseSlot('easter-egg-inputcard');
  }, []);

  const showFrontierEasterEgg = useCallback((type: 'NEW' | 'OLD') => {
    const key = `frontaliere_easter_egg_seen_${type.toLowerCase()}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    clearTimeout(easterEggTimer.current);
    setEasterEgg(type === 'OLD' ? `😎 ${t('permitCompare.easterEggOld')}` : `💪 ${t('permitCompare.easterEggNew')}`);
  }, [t]);
  
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
    // Validate salary field
    if (field === 'annualIncomeCHF') {
      const numVal = typeof value === 'number' ? value : 0;
      if (numVal < SALARY_MIN) {
        setSalaryError(t('input.salaryErrorNegative'));
        return;
      }
      if (numVal > SALARY_MAX) {
        setSalaryError(t('input.salaryErrorMax'));
        return;
      }
      setSalaryError(null);
    }
    setInputs(prev => ({ ...prev, [field]: value }));
    // Track funnel: first input interaction
    if (!inputStartTracked.current) {
      inputStartTracked.current = true;
      Analytics.trackFunnelStep('input_start', { first_field: field });
    }
    // Track important input changes
    if (['annualIncomeCHF', 'age', 'maritalStatus', 'hasChildren', 'numChildren', 'workerType', 'monthsWorked', 'hasHealthInsurance', 'cantonCode'].includes(field)) {
      Analytics.trackInputChange(field, value);
    }
  };

  const handleReset = () => {
    setInputs(DEFAULT_INPUTS);
    Analytics.trackUIInteraction('simulatore', 'input', 'bottone_reset', 'click');
  };
  
  const handleResetTech = () => {
    setInputs(prev => ({...prev, ...DEFAULT_TECH_PARAMS}));
  };

  const fetchRate = async () => {
    setLoadingRate(true);
    try {
      const { fetchExchangeRate } = await import('../../services/exchangeRateService');
      const rate = await fetchExchangeRate();
      handleChange('customExchangeRate', rate);
      setLastRateUpdate(new Date());
    } catch (e) {
      console.error('Failed rate fetch', e);
      reportCaughtError(e, 'inputCard.fetchExchangeRate');
    } finally {
      setLoadingRate(false);
    }
  };

  useEffect(() => {
    fetchRate();
    const interval = setInterval(fetchRate, 300000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!focusField || focusRequestId === 0) return;

    const targetId = focusField === 'age'
      ? 'input-age'
      : focusField === 'maritalStatus'
        ? 'maritalStatus'
        : 'input-children';

    const timer = window.setTimeout(() => {
      const target = document.getElementById(targetId) as HTMLInputElement | HTMLSelectElement | null;
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.focus({ preventScroll: true });
    }, 150);

    return () => window.clearTimeout(timer);
  }, [focusField, focusRequestId]);

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

  const addExpense = (target: 'CH' | 'IT', preset?: {label: string, amount: number, frequency?: 'MONTHLY' | 'ANNUAL', tooltip?: string}) => {
    const newItem: ExpenseItem = { 
        id: Math.random().toString(36).substr(2, 9), 
        label: preset ? preset.label : t('input.newExpense'), 
        amount: preset ? preset.amount : 0, 
        frequency: preset?.frequency || 'MONTHLY',
        tooltip: preset?.tooltip
    };
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: [...prev[target === 'CH' ? 'expensesCH' : 'expensesIT'], newItem] }));
    setShowPresets(null); // Close presets after adding
    Analytics.trackExpense('add', preset?.label || 'Custom', preset?.amount);
  };

  const removeExpense = (target: 'CH' | 'IT', id: string) => {
    const expenses = inputs[target === 'CH' ? 'expensesCH' : 'expensesIT'];
    const expense = expenses.find(e => e.id === id);
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: prev[target === 'CH' ? 'expensesCH' : 'expensesIT'].filter(e => e.id !== id) }));
    if (expense) {
      Analytics.trackExpense('delete', expense.label, expense.amount);
    }
  };

  const loadAllPresets = (target: 'CH' | 'IT') => {
    const presets = calculateDynamicExpenses(inputs.familyMembers, target);
    const newExpenses: ExpenseItem[] = presets.map(preset => ({
      id: Math.random().toString(36).substr(2, 9),
      label: preset.label,
      amount: preset.amount,
      frequency: (preset.frequency || 'MONTHLY') as 'MONTHLY' | 'ANNUAL',
      tooltip: preset.tooltip
    }));
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: newExpenses }));
    setShowPresets(null);
  };

  const resetExpenses = (target: 'CH' | 'IT') => {
    setInputs(prev => ({ ...prev, [target === 'CH' ? 'expensesCH' : 'expensesIT']: [] }));
  };

  return (
    <div className="bg-white/90 dark:bg-slate-900/90 rounded-[2rem] shadow-xl border border-white/60 dark:border-slate-800 h-full flex flex-col overflow-hidden transition-colors duration-300">
      {/* Header */}
      <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-white/50 dark:bg-slate-900/50 z-10">
        <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-teal-500 to-emerald-600 text-white rounded-xl shadow-lg shadow-teal-500/20">
              <Wand2 size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 tracking-tight">{isFocusMode ? t('input.summary') : t('input.title')}</h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 font-bold uppercase tracking-wider">{isFocusMode ? t('input.compactView') : t('input.subtitle')}</p>
            </div>
        </div>
        {!isFocusMode && (
          <button onClick={handleReset} className="p-2 text-slate-500 dark:text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2" title={t('input.resetAll')} aria-label={t('input.resetAll')}>
            <RotateCcw size={18} />
          </button>
        )}
      </div>

      {isFocusMode ? (
        /* COLLAPSED / FOCUS MODE VIEW */
        <div className="flex-grow overflow-y-auto custom-scrollbar p-4 space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-100 dark:border-amber-800/50">
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase">{t('input.ral')}</span>
              <span className="font-bold text-sm text-amber-700 dark:text-amber-300">CHF {Math.round(inputs.annualIncomeCHF).toLocaleString('it-IT')}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-800/50">
              <span className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase">{t('input.type')}</span>
              <span className="font-bold text-xs text-blue-700 dark:text-blue-300">{inputs.frontierWorkerType === 'NEW' ? t('input.newFrontShort') : t('input.oldFrontShort')}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700">
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase">{t('input.profile')}</span>
              <span className="font-bold text-xs text-slate-700 dark:text-slate-300">{inputs.age}a, {inputs.maritalStatus === 'SINGLE' ? t('input.single') : inputs.maritalStatus === 'MARRIED' ? t('input.married') : inputs.maritalStatus === 'DIVORCED' ? t('input.divorced') : t('input.widowed')}, {inputs.children > 0 ? t('input.childrenCount', { count: inputs.children }) : t('input.noChildren')}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800/50">
              <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase">{t('input.exchange')}</span>
              <span className="font-bold text-xs text-indigo-700 dark:text-indigo-300">1 CHF = {inputs.customExchangeRate} EUR</span>
            </div>
          </div>
        </div>
      ) : (

      <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-3 pb-20">
        
        {/* SECTION 1: MAIN INPUTS */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm">
           <div className="p-5 space-y-6">
              {/* Income Input - Prominent */}
              <div className="space-y-2">
                 <label className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                   <Coins size={14} className="text-amber-500"/> {t('input.grossAnnualIncome')} 
                   <InfoTooltip text={t('input.incomeTooltip')} />
                 </label>
                 <div className="flex items-stretch transition-transform duration-200 focus-within:scale-[1.01]">
                    <button
                      type="button"
                      onClick={() => handleChange('annualIncomeCHF', Math.max(SALARY_MIN, inputs.annualIncomeCHF - 1000))}
                      className={`shrink-0 w-12 bg-slate-50 dark:bg-slate-900 border-2 border-r-0 rounded-l-2xl transition-[color,background-color,transform] hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 ${salaryError ? 'border-red-400' : 'border-slate-100 dark:border-slate-700'} text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 flex items-center justify-center`}
                      aria-label="Diminuisci reddito di CHF 1000"
                    >
                      <Minus size={18} strokeWidth={2.5} />
                    </button>
                    <div className="relative flex-1 group">
                      <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <span className="text-slate-500 dark:text-slate-400 font-bold text-lg">CHF</span>
                      </div>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formatNumber(inputs.annualIncomeCHF)}
                        onChange={(e) => {
                          const val = parseNumber(e.target.value);
                          const clamped = Math.max(SALARY_MIN, Math.min(SALARY_MAX, val));
                          handleChange('annualIncomeCHF', clamped);
                        }}
                        aria-label="Reddito annuo lordo CHF"
                        className={`w-full pl-14 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-x-0 focus:ring-4 focus:ring-inset outline-none transition-[color,border-color,box-shadow] font-bold text-slate-800 dark:text-slate-100 text-2xl tracking-tight ${salaryError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/10' : 'border-slate-100 dark:border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/10'}`}
                        placeholder="0"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleChange('annualIncomeCHF', Math.min(SALARY_MAX, inputs.annualIncomeCHF + 1000))}
                      className={`shrink-0 w-12 bg-slate-50 dark:bg-slate-900 border-2 border-l-0 rounded-r-2xl transition-[color,background-color,transform] hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 ${salaryError ? 'border-red-400' : 'border-slate-100 dark:border-slate-700'} text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 flex items-center justify-center`}
                      aria-label="Aumenta reddito di CHF 1000"
                    >
                      <Plus size={18} strokeWidth={2.5} />
                    </button>
                 </div>
                 {salaryError && (
                   <p role="alert" aria-live="polite" className="text-xs text-red-600 dark:text-red-400 font-semibold mt-1 flex items-center gap-1">
                     <AlertTriangle size={12} /> {salaryError}
                   </p>
                 )}
                 <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-none pb-0.5">
                   {[50000, 75000, 100000, 120000, 150000].map((s) => (
                     <button
                       key={s}
                       type="button"
                       onClick={() => handleChange('annualIncomeCHF', s)}
                       className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                         inputs.annualIncomeCHF === s
                           ? 'bg-blue-600 text-white shadow-sm'
                           : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                       }`}
                     >
                       {s / 1000}k
                     </button>
                   ))}
                 </div>
              </div>

              {/* Demographics Grid */}
              <div className="grid grid-cols-2 gap-4 items-end">
                 <StepperInput inputId="input-age" label={t('input.age')} value={inputs.age} onChange={(v: number) => handleChange('age', v)} min={18} max={99} icon={User} iconColor="text-blue-500" tooltip={t('input.ageTooltip')} />
                 {/* Marital Status */}
                 <div className="space-y-1.5">
                   <label htmlFor="maritalStatus" className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5 h-4">
                     <Heart size={12} className="text-rose-500"/> {t('input.maritalStatus')}
                     <InfoTooltip text={t('input.maritalStatusTooltip')} />
                   </label>
                   <div className="relative">
                     <select 
                       id="maritalStatus"
                       value={inputs.maritalStatus} 
                       onChange={(e) => handleChange('maritalStatus', e.target.value)}
                       className="w-full h-12 pl-3 pr-8 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold uppercase appearance-none outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 transition-[color,border-color,box-shadow] cursor-pointer text-slate-700 dark:text-slate-200"
                     >
                       <option value="SINGLE">{t('input.single')}</option>
                       <option value="MARRIED">{t('input.married')}</option>
                       <option value="DIVORCED">{t('input.divorced')}</option>
                       <option value="WIDOWED">{t('input.widowed')}</option>
                     </select>
                     <ChevronDown size={14} className="absolute right-3 top-3.5 text-slate-500 dark:text-slate-400 pointer-events-none"/>
                   </div>
                 </div>
              </div>

              {/* Spouse Works Toggle */}
              {inputs.maritalStatus === 'MARRIED' && (
                 <div className="flex items-center justify-between bg-indigo-50/50 dark:bg-indigo-900/10 p-3 rounded-xl border border-indigo-100 dark:border-indigo-900/30 animate-fade-in mt-2">
                    <span className="text-xs font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5">
                      <Briefcase size={14} className="text-indigo-600"/> {t('input.spouseWorks')}
                      <InfoTooltip text={t('input.spouseWorksTooltip')} />
                    </span>
                    <button 
                      onClick={() => handleChange('spouseWorks', !inputs.spouseWorks)}
                      role="switch"
                      aria-checked={inputs.spouseWorks}
                      aria-label={t('input.spouseWorks')}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${inputs.spouseWorks ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                    >
                      <span className={`block w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-200 ease-in-out mt-1 ml-1 ${inputs.spouseWorks ? 'translate-x-5' : 'translate-x-0'}`}/>
                    </button>
                 </div>
              )}
           </div>
        </div>

        {/* SECTION 2: FRONTIER TYPE */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-4">
           <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest flex items-center gap-2">
             <TrainFront size={14} className="text-emerald-500"/> {t('input.frontierType')}
             <InfoTooltip text={t('input.frontierTypeTooltip')} />
           </h3>
           
           <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); if (inputs.frontierWorkerType !== 'NEW') showFrontierEasterEgg('NEW'); }} 
                className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'NEW' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-slate-300'}`}
              >
                  {inputs.frontierWorkerType === 'NEW' && <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'NEW' ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300'}`}>{t('input.newFrontier')}</span>
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium">{t('input.postDate')}</span>
              </button>
              <button 
                onClick={() => { handleChange('frontierWorkerType', 'OLD'); if (inputs.frontierWorkerType !== 'OLD') showFrontierEasterEgg('OLD'); }} 
                className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'OLD' ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20' : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-slate-300'}`}
              >
                   {inputs.frontierWorkerType === 'OLD' && <div className="absolute top-2 right-2 bg-emerald-700 text-white rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
                  <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'OLD' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'}`}>{t('input.oldFrontier')}</span>
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium">{t('input.preDate')}</span>
              </button>
           </div>
           
           {inputs.frontierWorkerType === 'NEW' && (
              <div className="pt-2 animate-fade-in">
                <SegmentControl 
                    label={t('input.borderZone')} 
                    icon={Ruler}
                    iconColor="text-orange-500"
                    tooltip={t('input.borderZoneTooltip')}
                    options={[{label: t('input.within20km'), value: 'WITHIN_20KM'}, {label: t('input.over20km'), value: 'OVER_20KM'}]} 
                    value={inputs.distanceZone} 
                    onChange={(v: any) => handleChange('distanceZone', v)} 
                 />
              </div>
           )}
        </div>

        {/* SECTION 3: FAMILY & INSURANCE */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-5">
           <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest flex items-center gap-2"><Castle size={14} className="text-purple-500"/> {t('input.familyHealth')}</h3>
           
           <div className="grid grid-cols-2 gap-4">
              <StepperInput inputId="input-familyMembers" label={t('input.familyMembers')} value={inputs.familyMembers} onChange={(v: number) => handleChange('familyMembers', v)} min={1} icon={Users} iconColor="text-cyan-500" />
              <StepperInput inputId="input-children" label={t('input.dependentChildren')} value={inputs.children} onChange={(v: number) => handleChange('children', v)} min={0} icon={Baby} iconColor="text-pink-500" tooltip={t('input.childrenTooltip')} />
           </div>
        </div>

        {/* SECTION 4: EXPENSES (COLLAPSIBLE) */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader title={t('input.fixedExpenses')} icon={Receipt} isOpen={openSections.expenses} onToggle={() => toggleSection('expenses')} iconColor="text-teal-500" />
           
           {openSections.expenses && (
             <div className="p-5 pt-0 space-y-6 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                {/* Switzerland Expenses */}
                <div className="space-y-3">
                   <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="text-xs font-bold text-indigo-600 uppercase flex items-center gap-1.5">
                          <Home size={12}/> {t('input.liveInCH')}
                          <InfoTooltip text={t('input.amountsCHF')} />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => resetExpenses('CH')} className="min-w-[44px] min-h-[44px] p-2.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600 transition-colors text-xs font-bold uppercase flex items-center justify-center gap-1" title={t('input.clearAll')} aria-label={t('input.clearAll')}>
                          <RotateCcw size={12}/>
                        </button>
                        <button onClick={() => loadAllPresets('CH')} className="px-2 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 text-white text-xs font-bold uppercase hover:from-blue-700 hover:to-blue-800 transition-[color,background-color,box-shadow] shadow-sm hover:shadow-md flex items-center gap-1">
                          <Home size={12}/> {t('input.prefill')}
                        </button>
                        <button onClick={() => setShowPresets(showPresets === 'CH' ? null : 'CH')} className={`min-w-[44px] min-h-[44px] p-2.5 rounded-lg transition-colors flex items-center justify-center gap-1 text-xs font-bold uppercase ${showPresets === 'CH' ? 'bg-blue-100 text-blue-700' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 hover:bg-blue-100'}`}>
                          <Plus size={14}/>
                        </button>
                      </div>
                   </div>
                   <p className="text-xs text-slate-600 dark:text-slate-400 -mt-1">{t('input.expensesCHFNote')}</p>
                   
                   {/* Smart Presets Area for CH */}
                   {showPresets === 'CH' && (
                     <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 mb-2 animate-fade-in">
                        <p className="text-xs text-slate-600 dark:text-slate-300 uppercase font-bold mb-2">{t('input.quickSuggestions')}:</p>
                        <div className="flex flex-wrap gap-2">
                           <button onClick={() => addExpense('CH')} className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-500 transition-colors">{t('input.empty')}</button>
                           {PRESET_EXPENSES_CH.map((preset, idx) => {
                             const Icon = IconsMap[preset.icon] || Home;
                             return (
                               <button 
                                 key={preset.label}
                                 onClick={() => addExpense('CH', {...preset, frequency: preset.frequency as 'MONTHLY' | 'ANNUAL'})}
                                 className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-500 transition-colors flex items-center gap-1.5"
                               >
                                  <Icon size={10} />
                                  {t(preset.label)}
                               </button>
                             )
                           })}
                        </div>
                     </div>
                   )}

                   <div className="space-y-2">
                     {inputs.expensesCH.map(exp => (
                        <div key={exp.id} className="flex gap-2 items-center group/exp animate-fade-in">
                          <div className="flex items-center flex-1 min-w-0">
                            <input 
                              type="text" 
                              value={t(exp.label)} 
                              onChange={e => updateExpense('CH', exp.id, { label: e.target.value })} 
                              className="flex-1 min-w-0 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-xs font-bold outline-none focus:border-indigo-500 transition-colors truncate"
                              title={t(exp.label)}
                              aria-label={t('input.expenseName') || 'Nome spesa CH'}
                            />
                            {exp.tooltip && <InfoTooltip text={t(exp.tooltip)} />}
                          </div>
                          <input type="number" value={exp.amount || ''} onChange={e => updateExpense('CH', exp.id, { amount: Number(e.target.value) })} placeholder="0" aria-label={t('input.expenseAmount') || 'Importo spesa CH'} className="w-14 sm:w-16 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-1 sm:px-2 py-2 text-xs font-mono font-bold outline-none focus:border-indigo-500 text-right transition-colors" />
                          <button onClick={() => updateExpense('CH', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-1.5 sm:px-2 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-[9px] font-bold uppercase text-slate-600 dark:text-slate-400 w-10 sm:w-12 text-center hover:bg-slate-200 transition-colors flex-shrink-0" aria-label={t('input.toggleFrequency') || 'Cambia frequenza mensile/annuale'}>{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
                          <button onClick={() => removeExpense('CH', exp.id)} className="p-2 sm:p-2.5 -m-1 text-slate-300 hover:text-red-500 transition-colors flex-shrink-0" aria-label={t('input.removeExpense')}><X size={14}/></button>
                        </div>
                     ))}
                     {inputs.expensesCH.length === 0 && !showPresets && <div className="text-xs text-slate-600 dark:text-slate-400 italic text-center py-4 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">{t('input.noExpenses')}</div>}
                   </div>
                </div>
                
                {/* Italy Expenses */}
                <div className="space-y-3">
                   <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="text-xs font-bold text-red-500 uppercase flex items-center gap-1.5">
                          <Car size={12}/> {t('input.liveInIT')}
                          <InfoTooltip text={t('input.amountsEUR')} />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => resetExpenses('IT')} className="min-w-[44px] min-h-[44px] p-2.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600 transition-colors text-xs font-bold uppercase flex items-center justify-center gap-1" title={t('input.clearAll')} aria-label={t('input.clearAll')}>
                          <RotateCcw size={12}/>
                        </button>
                        <button onClick={() => loadAllPresets('IT')} className="px-2 py-1.5 rounded-lg bg-gradient-to-r from-red-600 to-orange-600 text-white text-xs font-bold uppercase hover:from-red-700 hover:to-orange-700 transition-[color,background-color,box-shadow] shadow-sm hover:shadow-md flex items-center gap-1">
                          <Home size={12}/> {t('input.prefill')}
                        </button>
                        <button onClick={() => setShowPresets(showPresets === 'IT' ? null : 'IT')} className={`min-w-[44px] min-h-[44px] p-2.5 rounded-lg transition-colors flex items-center justify-center gap-1 text-xs font-bold uppercase ${showPresets === 'IT' ? 'bg-red-100 text-red-700' : 'bg-red-50 dark:bg-red-900/30 text-red-600 hover:bg-red-100'}`}>
                          <Plus size={14}/>
                        </button>
                      </div>
                   </div>
                   <p className="text-xs text-slate-600 dark:text-slate-400 -mt-1">{t('input.expensesEURNote')}</p>

                    {/* Smart Presets Area for IT */}
                   {showPresets === 'IT' && (
                     <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 mb-2 animate-fade-in">
                        <p className="text-xs text-slate-600 dark:text-slate-300 uppercase font-bold mb-2">{t('input.quickSuggestions')}:</p>
                        <div className="flex flex-wrap gap-2">
                           <button onClick={() => addExpense('IT')} className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-500 transition-colors">{t('input.empty')}</button>
                           {PRESET_EXPENSES_IT.map((preset, idx) => {
                             const Icon = IconsMap[preset.icon] || Home;
                             return (
                               <button 
                                 key={preset.label}
                                 onClick={() => addExpense('IT', {...preset, frequency: preset.frequency as 'MONTHLY' | 'ANNUAL'})}
                                 className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-500 transition-colors flex items-center gap-1.5"
                               >
                                  <Icon size={10} />
                                  {t(preset.label)}
                               </button>
                             )
                           })}
                        </div>
                     </div>
                   )}

                   <div className="space-y-2">
                     {inputs.expensesIT.map(exp => (
                        <div key={exp.id} className="flex gap-2 items-center group/exp animate-fade-in">
                          <div className="flex items-center flex-1 min-w-0">
                            <input 
                              type="text" 
                              value={t(exp.label)} 
                              onChange={e => updateExpense('IT', exp.id, { label: e.target.value })} 
                              className="flex-1 min-w-0 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-2 text-xs font-bold outline-none focus:border-indigo-500 transition-colors truncate"
                              title={t(exp.label)}
                              aria-label={t('input.expenseName') || 'Nome spesa IT'}
                            />
                            {exp.tooltip && <InfoTooltip text={t(exp.tooltip)} />}
                          </div>
                          <input type="number" value={exp.amount || ''} onChange={e => updateExpense('IT', exp.id, { amount: Number(e.target.value) })} placeholder="0" aria-label={t('input.expenseAmount') || 'Importo spesa IT'} className="w-14 sm:w-16 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-1 sm:px-2 py-2 text-xs font-mono font-bold outline-none focus:border-indigo-500 text-right transition-colors" />
                          <button onClick={() => updateExpense('IT', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-1.5 sm:px-2 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-[9px] font-bold uppercase text-slate-600 dark:text-slate-400 w-10 sm:w-12 text-center hover:bg-slate-200 transition-colors flex-shrink-0" aria-label={t('input.toggleFrequency') || 'Cambia frequenza mensile/annuale'}>{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
                          <button onClick={() => removeExpense('IT', exp.id)} className="p-2 sm:p-2.5 -m-1 text-slate-300 hover:text-red-500 transition-colors flex-shrink-0" aria-label={t('input.removeExpense')}><X size={14}/></button>
                        </div>
                     ))}
                      {inputs.expensesIT.length === 0 && !showPresets && <div className="text-xs text-slate-600 dark:text-slate-400 italic text-center py-4 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">{t('input.noExpenses')}</div>}
                   </div>
                </div>
             </div>
           )}
        </div>

        {/* SECTION 5: OPTIONS */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader title={t('input.calculationOptions')} icon={Settings2} isOpen={openSections.settings} onToggle={() => toggleSection('settings')} subtext={t('input.rateAndMonths')} iconColor="text-slate-500 dark:text-slate-400" />
           
           {openSections.settings && (
              <div className="p-5 pt-0 space-y-5 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                  <div className="grid grid-cols-2 gap-4 items-end">
                     <div className="space-y-2">
                        <div className="flex justify-between items-center h-4">
                            <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase flex items-center gap-1">
                                <Coins size={10} className="text-yellow-500" /> {t('input.exchangeRate')}
                                <InfoTooltip text={t('input.exchangeRateTooltip')} />
                            </label>
                            <button onClick={fetchRate} disabled={loadingRate} className={`text-[9px] flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 hover:text-indigo-600 font-bold transition-[color,opacity] ${loadingRate ? 'opacity-50' : ''}`}>
                                <RefreshCw size={8} className={loadingRate ? 'animate-spin' : ''} /> {lastRateUpdate ? t('input.live') : t('input.refresh')}
                            </button>
                        </div>
                        <input 
                           type="number" 
                           step="0.001" 
                           value={inputs.customExchangeRate} 
                           onChange={(e) => handleChange('customExchangeRate', Number(e.target.value))} 
                           aria-label={t('input.exchangeRate') || 'Tasso di cambio CHF/EUR'}
                           className="w-full h-11 bg-slate-50 dark:bg-slate-900 px-3 rounded-xl border border-slate-200 dark:border-slate-700 outline-none text-base font-bold focus:border-indigo-500 transition-colors" 
                        />
                     </div>
                     <StepperInput inputId="input-monthsBasis" label={t('input.monthsBasis')} value={inputs.monthsBasis} onChange={(v: number) => handleChange('monthsBasis', v)} min={12} max={15} icon={CalendarClock} iconColor="text-orange-400" tooltip={t('input.monthsTooltip')} />
                  </div>
                  
                  {/* Cassa Malati Moved Here */}
                  <div className="space-y-2 pt-2">
                      <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5 h-4">
                        <Bandage size={12} className="text-rose-500"/> {t('input.healthInsurance')}
                        <InfoTooltip text={t('input.healthInsuranceTooltip')} />
                      </label>
                      <div className="relative group">
                          <input type="number" value={inputs.healthInsuranceCHF || ''} onChange={(e) => handleChange('healthInsuranceCHF', Number(e.target.value))} aria-label={t('input.healthInsurance') || 'Cassa malati CHF'} className="w-full pl-3 pr-10 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-[color,border-color,box-shadow] font-bold text-slate-800 dark:text-slate-100 text-sm h-11" placeholder="0" />
                          <span className="absolute right-3 top-3.5 text-slate-600 dark:text-slate-300 font-bold text-xs">CHF</span>
                      </div>
                  </div>
                  
                  {/* Wealth Tax (CH residents only) */}
                  <div className="space-y-2 pt-2">
                      <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5 h-4">
                        <Landmark size={12} className="text-emerald-500"/> {t('input.netWealth')}
                        <InfoTooltip text={t('input.netWealthTooltip')} />
                      </label>
                      <div className="relative group">
                          <input type="number" value={inputs.netWealthCHF || ''} onChange={(e) => handleChange('netWealthCHF', Number(e.target.value))} aria-label={t('input.netWealth') || 'Patrimonio netto CHF'} className="w-full pl-3 pr-10 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-[color,border-color,box-shadow] font-bold text-slate-800 dark:text-slate-100 text-sm h-11" placeholder="0" />
                          <span className="absolute right-3 top-3.5 text-slate-600 dark:text-slate-300 font-bold text-xs">CHF</span>
                      </div>
                      <p className="text-[9px] text-slate-600 dark:text-slate-400">{t('input.netWealthNote')}</p>
                  </div>
              </div>
           )}
        </div>

        {/* SECTION 5: EXPERIMENTAL FEATURES - Only visible for OLD frontier workers */}
        {inputs.frontierWorkerType === 'OLD' && (
        <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-amber-100 dark:from-amber-950/30 dark:via-orange-950/30 dark:to-amber-900/40 rounded-2xl border border-amber-200 dark:border-amber-800 overflow-hidden shadow-md">
           <SectionHeader 
             title={t('input.experimentalFeatures')} 
             icon={Joystick} 
             isOpen={openSections.experimental} 
             onToggle={() => toggleSection('experimental')} 
             subtext={t('input.betaTesting')} 
             iconColor="text-amber-700"
           />
           
           {openSections.experimental && (
           <div className="p-4 space-y-3">
              
              {/* SSN Health Tax Toggle */}
              <div className="bg-white dark:bg-slate-900/50 p-4 rounded-xl border border-amber-100 dark:border-amber-900">
                 <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                       <div className="flex items-center gap-2 mb-1">
                          <PiggyBank size={14} className="text-amber-700 flex-shrink-0" />
                          <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('input.ssnHealthTax')}</h4>
                          <InfoTooltip text={t('input.ssnHealthTaxTooltip')} />
                       </div>
                       <p className="text-[9px] text-slate-600 dark:text-slate-300 leading-relaxed">
                          {t('input.ssnHealthTaxDesc')}
                       </p>
                    </div>
                    
                    {/* Beautiful Toggle Switch */}
                    <button 
                      onClick={() => handleChange('enableOldFrontierHealthTax', !inputs.enableOldFrontierHealthTax)}
                      aria-label={t('input.ssnHealthTax') || 'Contributo SSN sanitario'}
                      role="switch"
                      aria-checked={inputs.enableOldFrontierHealthTax}
                      className={`relative flex-shrink-0 w-14 h-7 rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 shadow-inner ${inputs.enableOldFrontierHealthTax ? 'bg-gradient-to-r from-amber-500 to-orange-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                    >
                      <span className={`block w-5 h-5 bg-white rounded-full shadow-lg transform transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] mt-1 ml-1 ${inputs.enableOldFrontierHealthTax ? 'translate-x-7' : 'translate-x-0'}`}/>
                      {inputs.enableOldFrontierHealthTax && (
                         <span className="absolute inset-0 flex items-center justify-start pl-2 text-white text-[8px] font-bold pointer-events-none">ON</span>
                      )}
                    </button>
                 </div>
                 
                 {/* Percentage Input - Only shown when enabled */}
                 {inputs.enableOldFrontierHealthTax && (
                    <div className="mt-3 space-y-2">
                       <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 p-2 rounded-lg">
                          <Check size={12} className="text-amber-700" />
                          <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300">{t('input.ssnTaxActive')}</span>
                       </div>
                       
                       <div className="flex items-center gap-2 bg-white dark:bg-slate-800 p-3 rounded-lg border border-amber-200 dark:border-amber-700">
                          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex-1">{t('input.netIncomePercentage')}</label>
                          <div className="flex items-center gap-1">
                             <input 
                               type="number" 
                               value={inputs.ssnHealthTaxPercentage} 
                               onChange={(e) => handleChange('ssnHealthTaxPercentage', Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)))} 
                               step="0.1"
                               min="0"
                               max="100"
                               aria-label={t('input.netIncomePercentage') || 'Percentuale reddito netto per contributo SSN'}
                               className="w-14 text-right bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-amber-500" 
                             />
                             <span className="text-xs font-bold text-slate-600 dark:text-slate-400">%</span>
                          </div>
                       </div>
                       
                       <p className="text-[8px] text-amber-700 dark:text-amber-400 italic px-2">
                          ℹ️ {t('input.ssnCapsNote')}
                       </p>
                    </div>
                 )}
              </div>
           </div>
           )}
        </div>
        )}

        {/* SECTION 6: TECHNICAL PARAMETERS (Now Top-Level) */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
           <SectionHeader 
             title={t('input.technicalParams')} 
             icon={Sliders} 
             isOpen={openSections.rates} 
             onToggle={() => toggleSection('rates')} 
             subtext={t('input.ratesAndCoefficients')} 
             iconColor="text-cyan-600"
             action={
               openSections.rates && (
                 <button onClick={handleResetTech} className="text-[9px] font-bold text-slate-600 dark:text-slate-400 hover:text-red-500 bg-slate-100 dark:bg-slate-900/50 px-2 py-1 rounded transition-colors" title={t('input.resetDefaults')}>
                    Reset
                 </button>
               )
             }
           />
           
           {openSections.rates && (
              <div className="p-5 pt-0 space-y-4 animate-fade-in border-t border-slate-50 dark:border-slate-800/50 mt-2 pt-4">
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold uppercase text-slate-600 dark:text-slate-400">{t('input.swissRates')}</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label={t('input.avsRate')} value={inputs.avsRate} onChange={(v) => handleChange('avsRate', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.acRate')} value={inputs.acRate} onChange={(v) => handleChange('acRate', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.laaRate')} value={inputs.laaRate} onChange={(v) => handleChange('laaRate', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.ijmRate')} value={inputs.ijmRate} onChange={(v) => handleChange('ijmRate', v)} isPercentage step="0.1" />
                      </div>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold uppercase text-slate-600 dark:text-slate-400">{t('input.lppPension')}</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label={t('input.lppAge25_34')} value={inputs.lppRate25_34} onChange={(v) => handleChange('lppRate25_34', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.lppAge35_44')} value={inputs.lppRate35_44} onChange={(v) => handleChange('lppRate35_44', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.lppAge45_54')} value={inputs.lppRate45_54} onChange={(v) => handleChange('lppRate45_54', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.lppAge55plus')} value={inputs.lppRate55_plus} onChange={(v) => handleChange('lppRate55_plus', v)} isPercentage step="0.1" />
                      </div>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900/30 p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold uppercase text-slate-600 dark:text-slate-400">{t('input.italy')}</h4>
                      <div className="grid grid-cols-2 gap-3">
                          <TechInput label={t('input.itSurchargeRate')} value={inputs.itAddizionaleRate} onChange={(v) => handleChange('itAddizionaleRate', v)} isPercentage step="0.1" />
                          <TechInput label={t('input.itWorkDeduction')} value={inputs.itWorkDeduction} onChange={(v) => handleChange('itWorkDeduction', v)} step="10" />
                      </div>
                  </div>
              </div>
           )}
        </div>

        {/* Data privacy disclaimer */}
        <div className="flex items-start gap-2.5 mx-5 mb-5 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-100 dark:border-emerald-900/50">
          <Shield size={14} className="text-emerald-700 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-700 dark:text-emerald-400 leading-relaxed">{t('input.dataDisclaimer')}</p>
        </div>

      </div>
      )}

      {/* Easter egg toast — discreet bottom-right, rendered via portal */}
      {easterEgg && easterEggVisible && createPortal(
        <div className="fixed bottom-28 md:bottom-16 right-4 sm:right-6 z-[70] animate-fade-in cursor-pointer" role="button" tabIndex={0} onClick={dismissEasterEgg} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissEasterEgg(); } }} aria-label="Chiudi notifica">
          <div className="bg-slate-800/90 dark:bg-slate-700/90 backdrop-blur-sm rounded-xl shadow-lg px-4 py-2.5 max-w-xs">
            <p className="text-xs font-medium text-white">{easterEgg}</p>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export const InputCard = React.memo(InputCardBase);
