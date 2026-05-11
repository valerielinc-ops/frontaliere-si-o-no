import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import { Wand2, Castle, Bandage, PiggyBank, CalendarClock, Joystick, Plus, Minus, ChevronDown, ChevronUp, Check, TrainFront, Coins, Receipt, Car, Home, User, Heart, Briefcase, Ruler, Baby, Users, Sliders, Calculator, RotateCcw, Settings2, RefreshCw, X, Zap, Wifi, ShoppingBasket, Bus, Fuel, Info, Smartphone, Droplet, Tv, Shield, Landmark, AlertTriangle, ChevronRight } from 'lucide-react';
import { SimulationInputs, ExpenseItem } from '../../types';
import { DEFAULT_INPUTS, DEFAULT_TECH_PARAMS, PRESET_EXPENSES_CH, PRESET_EXPENSES_IT, calculateDynamicExpenses } from '../../constants';
import { Analytics } from '../../services/analytics';
import { useTranslation } from '../../services/i18n';
import { useNavigationOptional } from '@/services/NavigationContext';
import { SegmentControl as SharedSegmentControl } from '@/components/shared/SegmentControl';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { reportCaughtError } from '@/services/errorReporter';
// exchangeRateService is lazy-loaded to reduce main bundle size

interface Props {
 inputs: SimulationInputs;
 setInputs: React.Dispatch<React.SetStateAction<SimulationInputs>>;
 onCalculate: () => void;
 focusField?: 'age' | 'maritalStatus' | 'children' | null;
 focusRequestId?: number;
 /** Optional result for desktop compact mode teaser preview */
 result?: import('../../types').SimulationResult | null;
}

// --- Icons Map for Dynamic Rendering ---
const IconsMap: Record<string, any> = {
 Home, ShoppingBasket, Wifi, Zap, Bus, Car, Fuel, Smartphone, Droplet, Tv
};

// --- Reusable Components ---

const InfoTooltip = ({ text }: { text: string }) => {
 const [open, setOpen] = useState(false);
 const ref = useRef<HTMLButtonElement>(null);
 useEffect(() => {
 if (!open) return;
 const close = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
 document.addEventListener('mousedown', close);
 document.addEventListener('touchstart', close);
 return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); };
 }, [open]);
 return (
 <button ref={ref} type="button" onClick={() => setOpen(v => !v)} aria-label="Info" className="group relative inline-flex items-center ml-1.5 cursor-help z-50">
 <Info size={12} className="text-muted hover:text-info transition-colors" />
 <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2.5 bg-surface-raised text-body text-xs font-medium leading-relaxed rounded-xl shadow-xl border border-edge text-center ${open ? 'block' : 'hidden group-hover:block'}`}>
 {text}
 <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-heading"></div>
 </div>
 </button>
 );
};

const iconBgMap: Record<string, string> = {
 'text-accent': 'bg-accent-subtle text-accent',
 'text-gray-500': 'bg-surface-raised/30 text-muted',
 'text-warning': 'bg-warning-subtle text-warning',
};

const SectionHeader = ({ title, icon: Icon, isOpen, onToggle, subtext, iconColor ="text-accent", action, sectionId }: any) => (
 <div
 onClick={onToggle}
 role="button"
 tabIndex={0}
 aria-expanded={isOpen}
 aria-controls={sectionId}
 onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
 className={`w-full flex items-center justify-between p-4 rounded-xl transition-[color,background-color,box-shadow] duration-300 group cursor-pointer ${isOpen ? 'bg-surface shadow-sm' : 'hover:bg-surface-alt'}`}
 >
 <div className="flex items-center gap-3">
 <div className={`p-2 rounded-lg transition-colors ${isOpen ? (iconBgMap[iconColor] ?? `bg-surface-raised ${iconColor}`) : 'bg-surface-raised text-subtle group-hover:bg-surface'}`}>
 <Icon size={18} />
 </div>
 <div className="text-left">
 <div className={`text-base font-semibold transition-colors ${isOpen ? 'text-strong' : 'text-subtle'}`}>{title}</div>
 {subtext && <div className="text-xs text-subtle font-medium uppercase tracking-wide">{subtext}</div>}
 </div>
 </div>
 <div className="flex items-center gap-2">
 {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
 <div className={`transition-transform duration-300 ${isOpen ? 'rotate-180 text-accent' : 'text-muted'}`}>
 <ChevronDown size={18} />
 </div>
 </div>
 </div>
);

const StepperInput = ({ value, onChange, min = 0, max, label, icon: Icon, iconColor ="text-muted", tooltip, inputId }: any) => (
 <div className="space-y-2 min-w-0">
 {label && <label htmlFor={inputId} className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5 min-h-4">{Icon && <Icon size={12} className={`${iconColor} shrink-0`}/>} <span className="truncate">{label}</span> {tooltip && <InfoTooltip text={tooltip} />}</label>}
 <div className="flex items-center bg-surface-alt border border-edge rounded-xl overflow-hidden h-12 shadow-sm focus-within:ring-2 focus-within:ring-accent/20 focus-within:border-accent transition-[color,border-color,box-shadow]">
 <button 
 onClick={() => onChange(Math.max(min, value - 1))}
 className="w-10 shrink-0 h-full flex items-center justify-center text-muted hover:text-accent hover:bg-surface-raised active:scale-90 transition-[color,background-color,transform] border-r border-edge"
 aria-label={`${label || 'Valore'}: diminuisci`}
 type="button"
 >
 <Minus size={16} strokeWidth={2.5} />
 </button>
 <div className="flex-1 min-w-[40px] h-full relative flex items-center justify-center bg-surface/50">
 <input 
 id={inputId}
 type="number" 
 inputMode="numeric"
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
 className="w-full h-full min-h-[48px] bg-transparent text-center font-bold text-base text-body outline-none focus-visible:ring-2 focus-visible:ring-accent appearance-none px-1 py-3"
 aria-label={label || 'Valore numerico'}
 />
 </div>
 <button 
 onClick={() => onChange(max ? Math.min(max, value + 1) : value + 1)}
 className="w-10 shrink-0 h-full flex items-center justify-center text-muted hover:text-accent hover:bg-surface-raised active:scale-90 transition-[color,background-color,transform] border-l border-edge"
 aria-label={`${label || 'Valore'}: aumenta`}
 type="button"
 >
 <Plus size={16} strokeWidth={2.5} />
 </button>
 </div>
 </div>
);

const SegmentField = ({ options, value, onChange, label, icon: Icon, iconColor = "text-muted", tooltip }: {
 options: { label: string; value: string }[];
 value: string;
 onChange: (v: string) => void;
 label?: string;
 icon?: React.ComponentType<{ size: number; className?: string }>;
 iconColor?: string;
 tooltip?: string;
}) => (
 <div className="space-y-2">
 {label && <label className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5 min-h-4">{Icon && <Icon size={12} className={iconColor}/>} {label} {tooltip && <InfoTooltip text={tooltip} />}</label>}
 <SharedSegmentControl
 options={options.map(o => ({ key: o.value, label: o.label }))}
 value={value}
 onChange={onChange}
 activeTextClass="text-section-calculator"
 size="sm"
 />
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
}> = ({ label, value, onChange, step ="0.01", suffix ="", isPercentage = false }) => {
 const displayValue = isPercentage ? parseFloat((value * 100).toFixed(3)) : value;

 return (
 <div className="space-y-2">
 <label className="text-sm font-bold text-subtle uppercase tracking-wide min-h-[2rem] flex items-end">{label}</label>
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
 className="w-full h-11 bg-surface px-3 rounded-xl border border-edge text-sm font-bold text-body outline-none focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent/10 transition-[color,border-color,box-shadow]"
 />
 {suffix && <span className="absolute right-3 top-3.5 text-xs font-bold text-subtle pointer-events-none">{suffix}</span>}
 </div>
 </div>
 );
};

const SALARY_MIN = 0;
const SALARY_MAX = 1_000_000;

const DESKTOP_EXPANDED_KEY = 'calc_desktop_expanded';

const InputCardBase: React.FC<Props> = ({ inputs, setInputs, onCalculate, focusField = null, focusRequestId = 0, result = null }) => {
 const { t, locale } = useTranslation();
 const nav = useNavigationOptional();
 const isFocusMode = nav?.isFocusMode;
 const isDesktop = useMediaQuery('(min-width: 1024px)');
 const [loadingRate, setLoadingRate] = useState(false);
 const [lastRateUpdate, setLastRateUpdate] = useState<Date | null>(null);
 const [showPresets, setShowPresets] = useState<'CH' | 'IT' | null>(null);
 const [salaryError, setSalaryError] = useState<string | null>(null);
 const [easterEgg, setEasterEgg] = useState<string | null>(null);
 const [easterEggVisible, setEasterEggVisible] = useState(false);
 const easterEggTimer = useRef<ReturnType<typeof setTimeout>>();
 const inputStartTracked = useRef(false);

 // Desktop progressive disclosure: compact mode shows only 3 key fields
 // Returns true (expanded) if user has previously expanded, else false (compact)
 const [desktopExpanded, setDesktopExpanded] = useState(() => {
 if (typeof window === 'undefined') return false;
 return localStorage.getItem(DESKTOP_EXPANDED_KEY) === '1';
 });

 const expandDesktop = useCallback(() => {
 setDesktopExpanded(true);
 localStorage.setItem(DESKTOP_EXPANDED_KEY, '1');
 Analytics.trackUIInteraction('simulatore', 'input', 'expand_full_form', 'click', undefined, 'calculator.input.expand_full_form');
 }, []);

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
 Analytics.trackFunnelStep('input_start', { funnel: 'calculator', first_field: field });
 }
 // Track important input changes
 if (['annualIncomeCHF', 'age', 'maritalStatus', 'hasChildren', 'numChildren', 'workerType', 'monthsWorked', 'hasHealthInsurance', 'cantonCode'].includes(field)) {
 Analytics.trackInputChange(field, value);
 }
 };

 const handleReset = () => {
 setInputs(DEFAULT_INPUTS);
 Analytics.trackUIInteraction('simulatore', 'input', 'bottone_reset', 'click', undefined, 'calculator.input.reset');
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
 <div data-testid="calculator-input-card" className="bg-surface/90 rounded-[2rem] shadow-xl border border-edge h-full flex flex-col overflow-hidden transition-colors duration-300">
 {/* Header */}
 <div className="p-5 border-b border-edge flex items-center justify-between bg-surface/50 z-10">
 <div className="flex items-center gap-3">
 <div className="p-2.5 bg-gradient-to-br from-info-strong to-success-strong text-on-accent rounded-xl shadow-lg shadow-info-strong/20">
 <Wand2 size={20} />
 </div>
 <div>
 <h2 className="text-base font-bold font-display text-strong tracking-tight">{isFocusMode ? t('input.summary') : t('input.title')}</h2>
 <p className="text-xs text-subtle font-bold uppercase tracking-wider">{isFocusMode ? t('input.compactView') : t('input.subtitle')}</p>
 </div>
 </div>
 {!isFocusMode && (
 <button onClick={handleReset} className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-danger hover:bg-danger-subtle rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" title={t('input.resetAll')} aria-label={t('input.resetAll')}>
 <RotateCcw size={18} />
 </button>
 )}
 </div>

 {isFocusMode ? (
 /* COLLAPSED / FOCUS MODE VIEW */
 <div className="flex-grow overflow-y-auto custom-scrollbar p-4 space-y-3">
 <div className="space-y-2">
 <div className="flex items-center justify-between p-3 bg-warning-subtle rounded-xl border border-warning-border/50">
 <span className="text-xs font-bold text-warning uppercase">{t('input.ral')}</span>
 <span className="font-bold text-sm text-warning">CHF {Math.round(inputs.annualIncomeCHF).toLocaleString('it-IT')}</span>
 </div>
 <div className="flex items-center justify-between p-3 bg-accent-subtle rounded-xl border border-accent-border/50">
 <span className="text-xs font-bold text-link uppercase">{t('input.type')}</span>
 <span className="font-bold text-sm text-accent">{inputs.frontierWorkerType === 'NEW' ? t('input.newFrontShort') : t('input.oldFrontShort')}</span>
 </div>
 <div className="flex items-center justify-between p-3 bg-surface-alt rounded-xl border border-edge">
 <span className="text-xs font-bold text-subtle uppercase">{t('input.profile')}</span>
 <span className="font-bold text-xs text-body">{inputs.age}a, {inputs.maritalStatus === 'SINGLE' ? t('input.single') : inputs.maritalStatus === 'MARRIED' ? t('input.married') : inputs.maritalStatus === 'DIVORCED' ? t('input.divorced') : t('input.widowed')}, {inputs.children > 0 ? t('input.childrenCount', { count: inputs.children }) : t('input.noChildren')}</span>
 </div>
 <div className="flex items-center justify-between p-3 bg-accent-subtle rounded-xl border border-accent-border/50">
 <span className="text-xs font-bold text-accent uppercase">{t('input.exchange')}</span>
 <span className="font-bold text-sm text-accent">1 CHF = {inputs.customExchangeRate} EUR</span>
 </div>
 </div>
 </div>
 ) : (!desktopExpanded && !isDesktop) ? (
 /* MOBILE COMPACT MODE — 3 key fields + teaser + expand CTA */
 <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-3 pb-20">
 <div className="bg-surface rounded-2xl border border-edge shadow-sm">
 <div className="p-5 space-y-6">
 {/* Income Input - Prominent (same as full form) */}
 <div className="space-y-2">
 <label className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5">
 <Coins size={14} className="text-warning"/> {t('input.grossAnnualIncome')}
 <InfoTooltip text={t('input.incomeTooltip')} />
 </label>
 <div className="flex items-stretch transition-transform duration-200 focus-within:scale-[1.01]">
 <button
 type="button"
 onClick={() => handleChange('annualIncomeCHF', Math.max(SALARY_MIN, inputs.annualIncomeCHF - 1000))}
 className={`shrink-0 w-12 bg-surface-alt border-2 border-r-0 rounded-l-2xl transition-[color,background-color,transform] hover:bg-surface-raised active:scale-95 ${salaryError ? 'border-danger' : 'border-edge'} text-muted hover:text-accent flex items-center justify-center`}
 aria-label="Diminuisci reddito di CHF 1000"
 >
 <Minus size={18} strokeWidth={2.5} />
 </button>
 <div className="relative flex-1 group">
 <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
 <span className="text-muted font-bold text-lg">CHF</span>
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
 aria-label={t('input.grossAnnualIncome') || 'Reddito annuo lordo CHF'}
 className={`w-full pl-14 pr-4 py-4 bg-surface-alt border-2 border-x-0 focus-visible:ring-4 focus-visible:ring-inset outline-none transition-[color,border-color,box-shadow] font-bold text-strong text-2xl tracking-tight ${salaryError ? 'border-danger focus-visible:border-danger focus-visible:ring-danger/10' : 'border-edge focus-visible:border-accent focus-visible:ring-accent/10'}`}
 placeholder="0"
 />
 </div>
 <button
 type="button"
 onClick={() => handleChange('annualIncomeCHF', Math.min(SALARY_MAX, inputs.annualIncomeCHF + 1000))}
 className={`shrink-0 w-12 bg-surface-alt border-2 border-l-0 rounded-r-2xl transition-[color,background-color,transform] hover:bg-surface-raised active:scale-95 ${salaryError ? 'border-danger' : 'border-edge'} text-muted hover:text-accent flex items-center justify-center`}
 aria-label="Aumenta reddito di CHF 1000"
 >
 <Plus size={18} strokeWidth={2.5} />
 </button>
 </div>
 {salaryError && (
 <p role="alert" aria-live="polite" className="text-sm text-danger font-semibold mt-1 flex items-center gap-1">
 <AlertTriangle size={12} /> {salaryError}
 </p>
 )}
 <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-none pb-0.5">
 {[50000, 75000, 100000, 120000, 150000].map((s) => (
 <button
 key={s}
 type="button"
 onClick={() => handleChange('annualIncomeCHF', s)}
 aria-label={`Stipendio annuo ${(s / 1000).toLocaleString('it-IT')} mila CHF`}
 aria-pressed={inputs.annualIncomeCHF === s}
 className={`shrink-0 min-h-[44px] px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
 inputs.annualIncomeCHF === s
 ? 'bg-accent-strong text-on-accent shadow-sm'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {s / 1000}k
 </button>
 ))}
 </div>
 </div>

 {/* Worker type selector (compact) */}
 <div className="space-y-2">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-widest flex items-center gap-2">
 <TrainFront size={14} className="text-success"/> {t('input.frontierType')}
 </h3>
 <div className="grid grid-cols-2 gap-3">
 <button
 onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); if (inputs.frontierWorkerType !== 'NEW') showFrontierEasterEgg('NEW'); }}
 className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'NEW' ? 'border-accent bg-accent-subtle/50' : 'border-edge bg-surface-alt hover:border-edge'}`}
 >
 {inputs.frontierWorkerType === 'NEW' && <div className="absolute top-2 right-2 bg-accent-strong text-on-accent rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
 <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'NEW' ? 'text-accent' : 'text-subtle'}`}>{t('input.newFrontier')}</span>
 <span className="text-xs text-subtle font-medium">{t('input.postDate')}</span>
 </button>
 <button
 onClick={() => { handleChange('frontierWorkerType', 'OLD'); if (inputs.frontierWorkerType !== 'OLD') showFrontierEasterEgg('OLD'); }}
 className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'OLD' ? 'border-success bg-success-subtle/50' : 'border-edge bg-surface-alt hover:border-edge'}`}
 >
 {inputs.frontierWorkerType === 'OLD' && <div className="absolute top-2 right-2 bg-success-strong text-on-accent rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
 <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'OLD' ? 'text-success' : 'text-subtle'}`}>{t('input.oldFrontier')}</span>
 <span className="text-xs text-subtle font-medium">{t('input.preDate')}</span>
 </button>
 </div>
 </div>

 {/* Age (compact) */}
 <StepperInput inputId="input-age-compact" label={t('input.age')} value={inputs.age} onChange={(v: number) => handleChange('age', v)} min={18} max={99} icon={User} iconColor="text-accent" tooltip={t('input.ageTooltip')} />
 </div>
 </div>

 {/* Teaser preview — shows a quick result summary when result is available */}
 {result && inputs.annualIncomeCHF > 0 && (
 <div className="bg-gradient-to-br from-success-subtle to-info-subtle rounded-2xl border border-success-border p-4 space-y-3">
 <div className="text-xs font-bold text-success uppercase tracking-widest">{t('input.compact.preview')}</div>
 <div className="grid grid-cols-2 gap-3">
 <div className="bg-surface/70 rounded-xl p-3 border border-success-border/50">
 <div className="text-xs text-accent font-bold uppercase mb-1">{t('results.switzerland')}</div>
 <div className="text-lg font-bold text-accent font-mono tabular-nums">
 CHF {Math.round(result.chResident.netIncomeMonthly).toLocaleString('it-IT')}
 </div>
 <div className="text-xs text-subtle font-medium">/{t('common.month') || 'mese'}</div>
 </div>
 <div className="bg-surface/70 rounded-xl p-3 border border-success-border/50">
 <div className="text-xs text-danger font-bold uppercase mb-1">{t('results.italy')}</div>
 <div className="text-lg font-bold text-danger font-mono tabular-nums">
 CHF {Math.round(result.itResident.netIncomeMonthly).toLocaleString('it-IT')}
 </div>
 <div className="text-xs text-subtle font-medium">/{t('common.month') || 'mese'}</div>
 </div>
 </div>
 <div className="text-xs text-success font-medium text-center">
 {t('input.compact.previewHint')}
 </div>
 </div>
 )}

 {/* Expand CTA */}
 <button
 type="button"
 onClick={expandDesktop}
 aria-label={t('input.compact.expandCta')}
 className="w-full flex items-center justify-between gap-3 p-4 bg-gradient-to-r from-accent-strong to-accent-strong-hover hover:from-accent-strong-hover hover:to-accent-strong-hover rounded-2xl text-on-accent shadow-md hover:shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-200 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
 >
 <div className="flex items-center gap-3">
 <div className="p-2 bg-on-accent/20 rounded-xl">
 <Sliders size={18} />
 </div>
 <div className="text-left">
 <div className="text-sm font-bold">{t('input.compact.expandCta')}</div>
 <div className="text-xs text-on-accent/70">{t('input.compact.expandHint')}</div>
 </div>
 </div>
 <ChevronRight size={20} className="text-on-accent/70 group-hover:translate-x-1 transition-transform" />
 </button>

 {/* Data privacy disclaimer (compact) */}
 <div className="flex items-start gap-2.5 mx-2 p-3 bg-success-subtle rounded-xl border border-success-border">
 <Shield size={12} className="text-success flex-shrink-0 mt-0.5" />
 <p className="text-xs text-success leading-relaxed">{t('input.dataDisclaimer')}</p>
 </div>
 </div>
 ) : (

 <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-4 pb-20">

 {/* SECTION 1: MAIN INPUTS */}
 <div className="bg-surface rounded-2xl border border-edge shadow-sm">
 <div className="p-5 space-y-6">
 {/* Income Input - Prominent */}
 <div className="space-y-2">
 <label className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5">
 <Coins size={14} className="text-warning"/> {t('input.grossAnnualIncome')} 
 <InfoTooltip text={t('input.incomeTooltip')} />
 </label>
 <div className="flex items-stretch transition-transform duration-200 focus-within:scale-[1.01]">
 <button
 type="button"
 onClick={() => handleChange('annualIncomeCHF', Math.max(SALARY_MIN, inputs.annualIncomeCHF - 1000))}
 className={`shrink-0 w-12 bg-surface-alt border-2 border-r-0 rounded-l-2xl transition-[color,background-color,transform] hover:bg-surface-raised active:scale-95 ${salaryError ? 'border-danger' : 'border-edge'} text-muted hover:text-accent flex items-center justify-center`}
 aria-label="Diminuisci reddito di CHF 1000"
 >
 <Minus size={18} strokeWidth={2.5} />
 </button>
 <div className="relative flex-1 group">
 <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
 <span className="text-muted font-bold text-lg">CHF</span>
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
 className={`w-full pl-14 pr-4 py-4 bg-surface-alt border-2 border-x-0 focus-visible:ring-4 focus-visible:ring-inset outline-none transition-[color,border-color,box-shadow] font-bold text-strong text-2xl tracking-tight ${salaryError ? 'border-danger focus-visible:border-danger focus-visible:ring-danger/10' : 'border-edge focus-visible:border-accent focus-visible:ring-accent/10'}`}
 placeholder="0"
 />
 </div>
 <button
 type="button"
 onClick={() => handleChange('annualIncomeCHF', Math.min(SALARY_MAX, inputs.annualIncomeCHF + 1000))}
 className={`shrink-0 w-12 bg-surface-alt border-2 border-l-0 rounded-r-2xl transition-[color,background-color,transform] hover:bg-surface-raised active:scale-95 ${salaryError ? 'border-danger' : 'border-edge'} text-muted hover:text-accent flex items-center justify-center`}
 aria-label="Aumenta reddito di CHF 1000"
 >
 <Plus size={18} strokeWidth={2.5} />
 </button>
 </div>
 {salaryError && (
 <p role="alert" aria-live="polite" className="text-sm text-danger font-semibold mt-1 flex items-center gap-1">
 <AlertTriangle size={12} /> {salaryError}
 </p>
 )}
 <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-none pb-0.5">
 {[50000, 75000, 100000, 120000, 150000].map((s) => (
 <button
 key={s}
 type="button"
 onClick={() => handleChange('annualIncomeCHF', s)}
 aria-label={`Stipendio annuo ${(s / 1000).toLocaleString('it-IT')} mila CHF`}
 aria-pressed={inputs.annualIncomeCHF === s}
 className={`shrink-0 min-h-[44px] px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
 inputs.annualIncomeCHF === s
 ? 'bg-accent-strong text-on-accent shadow-sm'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {s / 1000}k
 </button>
 ))}
 </div>
 </div>

 {/* Demographics Grid */}
 <div className="grid grid-cols-2 gap-4 items-end">
 <StepperInput inputId="input-age" label={t('input.age')} value={inputs.age} onChange={(v: number) => handleChange('age', v)} min={18} max={99} icon={User} iconColor="text-accent" tooltip={t('input.ageTooltip')} />
 {/* Marital Status */}
 <div className="space-y-1.5">
 <label htmlFor="maritalStatus" className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5 h-4">
 <Heart size={12} className="text-danger"/> {t('input.maritalStatus')}
 <InfoTooltip text={t('input.maritalStatusTooltip')} />
 </label>
 <div className="relative">
 <select 
 id="maritalStatus"
 value={inputs.maritalStatus} 
 onChange={(e) => handleChange('maritalStatus', e.target.value)}
 className="w-full h-12 pl-3 pr-8 bg-surface-alt border border-edge rounded-xl text-sm font-bold uppercase appearance-none outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/10 transition-[color,border-color,box-shadow] cursor-pointer text-body"
 >
 <option value="SINGLE">{t('input.single')}</option>
 <option value="MARRIED">{t('input.married')}</option>
 <option value="DIVORCED">{t('input.divorced')}</option>
 <option value="WIDOWED">{t('input.widowed')}</option>
 </select>
 <ChevronDown size={14} className="absolute right-3 top-3.5 text-muted pointer-events-none"/>
 </div>
 </div>
 </div>

 {/* Spouse Works Toggle */}
 {inputs.maritalStatus === 'MARRIED' && (
 <div className="flex items-center justify-between bg-accent-subtle/50 p-3 rounded-xl border border-accent-border animate-fade-in mt-2">
 <span className="text-sm font-bold text-accent flex items-center gap-1.5">
 <Briefcase size={14} className="text-accent"/> {t('input.spouseWorks')}
 <InfoTooltip text={t('input.spouseWorksTooltip')} />
 </span>
 <button 
 onClick={() => handleChange('spouseWorks', !inputs.spouseWorks)}
 role="switch"
 aria-checked={inputs.spouseWorks}
 aria-label={t('input.spouseWorks')}
 className={`relative w-11 h-6 rounded-full transition-colors duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent after:absolute after:-inset-[10px] after:content-[''] ${inputs.spouseWorks ? 'bg-accent-strong' : 'bg-surface-raised'}`}
 >
 <span className={`block w-4 h-4 bg-surface rounded-full shadow-md transform transition-transform duration-200 ease-out mt-1 ml-1 ${inputs.spouseWorks ? 'translate-x-5' : 'translate-x-0'}`}/>
 </button>
 </div>
 )}
 </div>
 </div>

 {/* SECTION 2: FRONTIER TYPE */}
 <div className="bg-surface rounded-2xl border border-edge shadow-sm p-5 space-y-5">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-widest flex items-center gap-2">
 <TrainFront size={14} className="text-success"/> {t('input.frontierType')}
 <InfoTooltip text={t('input.frontierTypeTooltip')} />
 </h3>
 
 <div className="grid grid-cols-2 gap-3">
 <button 
 onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); if (inputs.frontierWorkerType !== 'NEW') showFrontierEasterEgg('NEW'); }} 
 className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'NEW' ? 'border-accent bg-accent-subtle/50' : 'border-edge bg-surface-alt hover:border-edge'}`}
 >
 {inputs.frontierWorkerType === 'NEW' && <div className="absolute top-2 right-2 bg-accent-strong text-on-accent rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
 <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'NEW' ? 'text-accent' : 'text-subtle'}`}>{t('input.newFrontier')}</span>
 <span className="text-xs text-subtle font-medium">{t('input.postDate')}</span>
 </button>
 <button
 onClick={() => { handleChange('frontierWorkerType', 'OLD'); if (inputs.frontierWorkerType !== 'OLD') showFrontierEasterEgg('OLD'); }}
 className={`relative p-3 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center justify-center text-center gap-1 group ${inputs.frontierWorkerType === 'OLD' ? 'border-success bg-success-subtle/50' : 'border-edge bg-surface-alt hover:border-edge'}`}
 >
 {inputs.frontierWorkerType === 'OLD' && <div className="absolute top-2 right-2 bg-success-strong text-on-accent rounded-full p-0.5"><Check size={10} strokeWidth={4} /></div>}
 <span className={`font-bold text-sm ${inputs.frontierWorkerType === 'OLD' ? 'text-success' : 'text-subtle'}`}>{t('input.oldFrontier')}</span>
 <span className="text-xs text-subtle font-medium">{t('input.preDate')}</span>
 </button>
 </div>

 {inputs.frontierWorkerType === 'NEW' && (
 <div className="pt-2 animate-fade-in">
 <SegmentField
 label={t('input.borderZone')}
 icon={Ruler}
 iconColor="text-warning"
 tooltip={t('input.borderZoneTooltip')}
 options={[{label: t('input.within20km'), value: 'WITHIN_20KM'}, {label: t('input.over20km'), value: 'OVER_20KM'}]}
 value={inputs.distanceZone}
 onChange={(v) => handleChange('distanceZone', v)}
 />
 </div>
 )}
 </div>

 {/* SECTION 3: FAMILY & INSURANCE */}
 <div className="bg-surface rounded-2xl border border-edge shadow-sm p-5 space-y-5">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-widest flex items-center gap-2"><Castle size={14} className="text-accent"/> {t('input.familyHealth')}</h3>
 
 <div className="grid grid-cols-2 gap-4">
 <StepperInput inputId="input-familyMembers" label={t('input.familyMembers')} value={inputs.familyMembers} onChange={(v: number) => handleChange('familyMembers', v)} min={1} max={20} icon={Users} iconColor="text-info" />
 <StepperInput inputId="input-children" label={t('input.dependentChildren')} value={inputs.children} onChange={(v: number) => handleChange('children', v)} min={0} max={20} icon={Baby} iconColor="text-danger" tooltip={t('input.childrenTooltip')} />
 </div>
 </div>

 {/* SECTION 4: EXPENSES (COLLAPSIBLE) */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden shadow-sm">
 <SectionHeader title={t('input.fixedExpenses')} icon={Receipt} isOpen={openSections.expenses} onToggle={() => toggleSection('expenses')} iconColor="text-info" />
 
 {openSections.expenses && (
 <div className="p-5 pt-0 space-y-6 animate-fade-in border-t border-edge mt-2 pt-4">
 {/* Switzerland Expenses */}
 <div className="space-y-3">
 <div className="flex items-center justify-between gap-2">
 <div className="flex items-center gap-2">
 <div className="text-sm font-bold text-accent uppercase flex items-center gap-1.5">
 <Home size={12}/> {t('input.liveInCH')}
 <InfoTooltip text={t('input.amountsCHF')} />
 </div>
 </div>
 <div className="flex items-center gap-1.5">
 <button onClick={() => resetExpenses('CH')} className="min-w-[44px] min-h-[44px] p-2.5 rounded-lg bg-surface-raised text-subtle hover:bg-danger-subtle hover:text-danger transition-colors text-xs font-bold uppercase flex items-center justify-center gap-1" title={t('input.clearAll')} aria-label={t('input.clearAll')}>
 <RotateCcw size={12}/>
 </button>
 <button onClick={() => loadAllPresets('CH')} className="min-w-[44px] min-h-[44px] px-2 py-1.5 rounded-lg bg-gradient-to-r from-accent-strong to-accent-strong-hover text-on-accent text-xs font-bold uppercase hover:from-accent-strong-hover hover:to-accent-strong-hover transition-[color,background-color,box-shadow] shadow-sm hover:shadow-md flex items-center gap-1">
 <Home size={12}/> {t('input.prefill')}
 </button>
 <button onClick={() => setShowPresets(showPresets === 'CH' ? null : 'CH')} className={`min-w-[44px] min-h-[44px] p-2.5 rounded-lg transition-colors flex items-center justify-center gap-1 text-xs font-bold uppercase ${showPresets === 'CH' ? 'bg-accent-subtle text-accent' : 'bg-accent-subtle text-accent hover:bg-accent-subtle'}`} aria-label="Aggiungi spese Svizzera" aria-expanded={showPresets === 'CH'}>
 <Plus size={14}/>
 </button>
 </div>
 </div>
 <p className="text-xs text-subtle -mt-1">{t('input.expensesCHFNote')}</p>
 
 {/* Smart Presets Area for CH */}
 {showPresets === 'CH' && (
 <div className="p-3 bg-surface-alt/50 rounded-xl border border-dashed border-edge mb-2 animate-fade-in">
 <p className="text-xs text-subtle uppercase font-bold mb-2">{t('input.quickSuggestions')}:</p>
 <div className="flex flex-wrap gap-2">
 <button onClick={() => addExpense('CH')} className="px-2 py-1.5 min-h-[44px] rounded-lg border border-edge bg-surface text-xs font-bold text-subtle hover:border-accent-border hover:text-accent transition-colors">{t('input.empty')}</button>
 {PRESET_EXPENSES_CH.map((preset, idx) => {
 const Icon = IconsMap[preset.icon] || Home;
 return (
 <button 
 key={preset.label}
 onClick={() => addExpense('CH', {...preset, frequency: preset.frequency as 'MONTHLY' | 'ANNUAL'})}
 className="px-2 py-1.5 rounded-lg border border-edge bg-surface text-xs font-bold text-subtle hover:border-accent-border hover:text-accent transition-colors flex items-center gap-1.5"
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
 className="flex-1 min-w-0 bg-surface-alt border border-edge rounded-lg px-2 py-2 text-xs font-bold outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 transition-colors truncate"
 title={t(exp.label)}
 aria-label={t('input.expenseName') || 'Nome spesa CH'}
 />
 {exp.tooltip && <InfoTooltip text={t(exp.tooltip)} />}
 </div>
 <input type="number" inputMode="numeric" value={exp.amount || ''} onChange={e => updateExpense('CH', exp.id, { amount: Number(e.target.value) })} placeholder="0" aria-label={t('input.expenseAmount') || 'Importo spesa CH'} className="w-14 sm:w-16 bg-surface-alt border border-edge rounded-lg px-1 sm:px-2 py-2 text-xs font-mono font-bold outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 text-right transition-colors" />
 <button onClick={() => updateExpense('CH', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-1.5 sm:px-2 py-2 min-h-[44px] bg-surface-raised rounded-lg text-xs font-bold uppercase text-subtle w-10 sm:w-12 text-center hover:bg-surface-raised transition-colors flex-shrink-0" aria-label={t('input.toggleFrequency') || 'Cambia frequenza mensile/annuale'}>{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
 <button onClick={() => removeExpense('CH', exp.id)} className="p-2 sm:p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-muted hover:text-danger transition-colors flex-shrink-0" aria-label={t('input.removeExpense')}><X size={14}/></button>
 </div>
 ))}
 {inputs.expensesCH.length === 0 && !showPresets && <div className="text-xs text-subtle italic text-center py-4 bg-surface-alt/50 rounded-xl border border-dashed border-edge">{t('input.noExpenses')}</div>}
 </div>
 </div>
 
 {/* Italy Expenses */}
 <div className="space-y-3">
 <div className="flex items-center justify-between gap-2">
 <div className="flex items-center gap-2">
 <div className="text-sm font-bold text-danger uppercase flex items-center gap-1.5">
 <Car size={12}/> {t('input.liveInIT')}
 <InfoTooltip text={t('input.amountsEUR')} />
 </div>
 </div>
 <div className="flex items-center gap-1.5">
 <button onClick={() => resetExpenses('IT')} className="min-w-[44px] min-h-[44px] p-2.5 rounded-lg bg-surface-raised text-subtle hover:bg-danger-subtle hover:text-danger transition-colors text-xs font-bold uppercase flex items-center justify-center gap-1" title={t('input.clearAll')} aria-label={t('input.clearAll')}>
 <RotateCcw size={12}/>
 </button>
 <button onClick={() => loadAllPresets('IT')} className="min-w-[44px] min-h-[44px] px-2 py-1.5 rounded-lg bg-gradient-to-r from-danger-strong to-warning-strong text-on-accent text-xs font-bold uppercase hover:from-danger-strong-hover hover:to-warning-strong-hover transition-[color,background-color,box-shadow] shadow-sm hover:shadow-md flex items-center gap-1">
 <Home size={12}/> {t('input.prefill')}
 </button>
 <button onClick={() => setShowPresets(showPresets === 'IT' ? null : 'IT')} className={`min-w-[44px] min-h-[44px] p-2.5 rounded-lg transition-colors flex items-center justify-center gap-1 text-xs font-bold uppercase ${showPresets === 'IT' ? 'bg-danger-subtle text-danger' : 'bg-danger-subtle text-danger hover:bg-danger-subtle'}`} aria-label="Aggiungi spese Italia" aria-expanded={showPresets === 'IT'}>
 <Plus size={14}/>
 </button>
 </div>
 </div>
 <p className="text-xs text-subtle -mt-1">{t('input.expensesEURNote')}</p>

 {/* Smart Presets Area for IT */}
 {showPresets === 'IT' && (
 <div className="p-3 bg-surface-alt/50 rounded-xl border border-dashed border-edge mb-2 animate-fade-in">
 <p className="text-xs text-subtle uppercase font-bold mb-2">{t('input.quickSuggestions')}:</p>
 <div className="flex flex-wrap gap-2">
 <button onClick={() => addExpense('IT')} className="px-2 py-1.5 min-h-[44px] rounded-lg border border-edge bg-surface text-xs font-bold text-subtle hover:border-danger hover:text-danger transition-colors">{t('input.empty')}</button>
 {PRESET_EXPENSES_IT.map((preset, idx) => {
 const Icon = IconsMap[preset.icon] || Home;
 return (
 <button 
 key={preset.label}
 onClick={() => addExpense('IT', {...preset, frequency: preset.frequency as 'MONTHLY' | 'ANNUAL'})}
 className="px-2 py-1.5 rounded-lg border border-edge bg-surface text-xs font-bold text-subtle hover:border-danger hover:text-danger transition-colors flex items-center gap-1.5"
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
 className="flex-1 min-w-0 bg-surface-alt border border-edge rounded-lg px-2 py-2 text-xs font-bold outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 transition-colors truncate"
 title={t(exp.label)}
 aria-label={t('input.expenseName') || 'Nome spesa IT'}
 />
 {exp.tooltip && <InfoTooltip text={t(exp.tooltip)} />}
 </div>
 <input type="number" inputMode="numeric" value={exp.amount || ''} onChange={e => updateExpense('IT', exp.id, { amount: Number(e.target.value) })} placeholder="0" aria-label={t('input.expenseAmount') || 'Importo spesa IT'} className="w-14 sm:w-16 bg-surface-alt border border-edge rounded-lg px-1 sm:px-2 py-2 text-xs font-mono font-bold outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 text-right transition-colors" />
 <button onClick={() => updateExpense('IT', exp.id, { frequency: exp.frequency === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY' })} className="px-1.5 sm:px-2 py-2 min-h-[44px] bg-surface-raised rounded-lg text-xs font-bold uppercase text-subtle w-10 sm:w-12 text-center hover:bg-surface-raised transition-colors flex-shrink-0" aria-label={t('input.toggleFrequency') || 'Cambia frequenza mensile/annuale'}>{exp.frequency === 'MONTHLY' ? '/m' : '/a'}</button>
 <button onClick={() => removeExpense('IT', exp.id)} className="p-2 sm:p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-muted hover:text-danger transition-colors flex-shrink-0" aria-label={t('input.removeExpense')}><X size={14}/></button>
 </div>
 ))}
 {inputs.expensesIT.length === 0 && !showPresets && <div className="text-xs text-subtle italic text-center py-4 bg-surface-alt/50 rounded-xl border border-dashed border-edge">{t('input.noExpenses')}</div>}
 </div>
 </div>
 </div>
 )}
 </div>

 {/* SECTION 5: OPTIONS */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden shadow-sm">
 <SectionHeader title={t('input.calculationOptions')} icon={Settings2} isOpen={openSections.settings} onToggle={() => toggleSection('settings')} subtext={t('input.rateAndMonths')} iconColor="text-muted" />
 
 {openSections.settings && (
 <div className="p-5 pt-0 space-y-5 animate-fade-in border-t border-edge mt-2 pt-4">
 <div className="grid grid-cols-2 gap-4 items-end">
 <div className="space-y-2">
 <div className="flex justify-between items-center h-4">
 <label className="text-sm font-bold text-subtle uppercase flex items-center gap-1">
 <Coins size={10} className="text-warning" /> {t('input.exchangeRate')}
 <InfoTooltip text={t('input.exchangeRateTooltip')} />
 </label>
 <button onClick={fetchRate} disabled={loadingRate} aria-label={t('input.refresh') || 'Aggiorna tasso di cambio'} className={`text-xs flex items-center gap-1 min-w-[44px] min-h-[44px] px-1.5 py-0.5 rounded bg-surface-raised hover:text-accent font-bold transition-[color,opacity] ${loadingRate ? 'opacity-50' : ''}`}>
 <RefreshCw size={8} className={loadingRate ? 'animate-spin' : ''} /> {lastRateUpdate ? t('input.live') : t('input.refresh')}
 </button>
 </div>
 <input 
 type="number" 
 inputMode="decimal"
 step="0.001" 
 value={inputs.customExchangeRate} 
 onChange={(e) => handleChange('customExchangeRate', Number(e.target.value))} 
 aria-label={t('input.exchangeRate') || 'Tasso di cambio CHF/EUR'}
 className="w-full h-11 bg-surface-alt px-3 rounded-xl border border-edge outline-none text-base font-bold focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 transition-colors" 
 />
 </div>
 <StepperInput inputId="input-monthsBasis" label={t('input.monthsBasis')} value={inputs.monthsBasis} onChange={(v: number) => handleChange('monthsBasis', v)} min={12} max={15} icon={CalendarClock} iconColor="text-warning" tooltip={t('input.monthsTooltip')} />
 </div>
 
 {/* Cassa Malati Moved Here */}
 <div className="space-y-2 pt-2">
 <label className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5 h-4">
 <Bandage size={12} className="text-danger"/> {t('input.healthInsurance')}
 <InfoTooltip text={t('input.healthInsuranceTooltip')} />
 </label>
 <div className="relative group">
 <input type="number" inputMode="numeric" value={inputs.healthInsuranceCHF || ''} onChange={(e) => handleChange('healthInsuranceCHF', Number(e.target.value))} aria-label={t('input.healthInsurance') || 'Cassa malati CHF'} className="w-full pl-3 pr-10 py-3 bg-surface-alt border border-edge rounded-xl focus-visible:ring-4 focus-visible:ring-accent-subtle focus-visible:border-accent outline-none transition-[color,border-color,box-shadow] font-bold text-strong text-base h-11" placeholder="0" />
 <span className="absolute right-3 top-3.5 text-subtle font-bold text-xs">CHF</span>
 </div>
 </div>
 
 {/* Wealth Tax (CH residents only) */}
 <div className="space-y-2 pt-2">
 <label className="text-sm font-bold text-subtle uppercase tracking-wide flex items-center gap-1.5 h-4">
 <Landmark size={12} className="text-success"/> {t('input.netWealth')}
 <InfoTooltip text={t('input.netWealthTooltip')} />
 </label>
 <div className="relative group">
 <input type="number" inputMode="numeric" value={inputs.netWealthCHF || ''} onChange={(e) => handleChange('netWealthCHF', Number(e.target.value))} aria-label={t('input.netWealth') || 'Patrimonio netto CHF'} className="w-full pl-3 pr-10 py-3 bg-surface-alt border border-edge rounded-xl focus-visible:ring-4 focus-visible:ring-accent-subtle focus-visible:border-accent outline-none transition-[color,border-color,box-shadow] font-bold text-strong text-base h-11" placeholder="0" />
 <span className="absolute right-3 top-3.5 text-subtle font-bold text-xs">CHF</span>
 </div>
 <p className="text-xs text-subtle">{t('input.netWealthNote')}</p>
 </div>
 </div>
 )}
 </div>

 {/* SECTION 5: EXPERIMENTAL FEATURES - Only visible for OLD frontier workers */}
 {inputs.frontierWorkerType === 'OLD' && (
 <div className="bg-gradient-to-br from-warning-subtle via-warning-subtle to-warning-subtle rounded-2xl border border-warning-border overflow-hidden shadow-md">
 <SectionHeader 
 title={t('input.experimentalFeatures')} 
 icon={Joystick} 
 isOpen={openSections.experimental} 
 onToggle={() => toggleSection('experimental')} 
 subtext={t('input.betaTesting')} 
 iconColor="text-warning"
 />
 
 {openSections.experimental && (
 <div className="p-4 space-y-3">
 
 {/* SSN Health Tax Toggle */}
 <div className="bg-surface/50 p-4 rounded-xl border border-warning-border">
 <div className="flex items-start justify-between gap-3">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 mb-1">
 <PiggyBank size={14} className="text-warning flex-shrink-0" />
 <h4 className="text-sm font-bold text-strong">{t('input.ssnHealthTax')}</h4>
 <InfoTooltip text={t('input.ssnHealthTaxTooltip')} />
 </div>
 <p className="text-sm text-subtle leading-relaxed">
 {t('input.ssnHealthTaxDesc')}
 </p>
 </div>
 
 {/* Beautiful Toggle Switch */}
 <button 
 onClick={() => handleChange('enableOldFrontierHealthTax', !inputs.enableOldFrontierHealthTax)}
 aria-label={t('input.ssnHealthTax') || 'Contributo SSN sanitario'}
 role="switch"
 aria-checked={inputs.enableOldFrontierHealthTax}
 className={`relative flex-shrink-0 w-14 h-7 rounded-full transition-colors duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-warning shadow-inner after:absolute after:-inset-[9px] after:content-[''] ${inputs.enableOldFrontierHealthTax ? 'bg-warning-strong' : 'bg-surface-raised'}`}
 >
 <span className={`block w-5 h-5 bg-surface rounded-full shadow-lg transform transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] mt-1 ml-1 ${inputs.enableOldFrontierHealthTax ? 'translate-x-7' : 'translate-x-0'}`}/>
 {inputs.enableOldFrontierHealthTax && (
 <span className="absolute inset-0 flex items-center justify-start pl-2 text-on-accent text-xs font-bold pointer-events-none">ON</span>
 )}
 </button>
 </div>
 
 {/* Percentage Input - Only shown when enabled */}
 {inputs.enableOldFrontierHealthTax && (
 <div className="mt-3 space-y-2">
 <div className="flex items-center gap-2 bg-warning-subtle p-2 rounded-lg">
 <Check size={12} className="text-warning" />
 <span className="text-xs font-bold text-warning">{t('input.ssnTaxActive')}</span>
 </div>
 
 <div className="flex items-center gap-2 bg-surface p-3 rounded-lg border border-warning-border">
 <label className="text-sm font-semibold text-body flex-1">{t('input.netIncomePercentage')}</label>
 <div className="flex items-center gap-1">
 <input 
 type="number" 
 inputMode="decimal"
 value={inputs.ssnHealthTaxPercentage} 
 onChange={(e) => handleChange('ssnHealthTaxPercentage', Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)))} 
 step="0.1"
 min="0"
 max="100"
 aria-label={t('input.netIncomePercentage') || 'Percentuale reddito netto per contributo SSN'}
 className="w-14 text-right bg-surface-alt text-strong border border-edge rounded px-2 py-1 text-xs font-bold focus:outline-none focus-visible:ring-1 focus-visible:ring-warning" 
 />
 <span className="text-xs font-bold text-subtle">%</span>
 </div>
 </div>
 
 <p className="text-sm text-warning italic px-2">
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
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden shadow-sm">
 <SectionHeader 
 title={t('input.technicalParams')} 
 icon={Sliders} 
 isOpen={openSections.rates} 
 onToggle={() => toggleSection('rates')} 
 subtext={t('input.ratesAndCoefficients')} 
 iconColor="text-info"
 action={
 openSections.rates && (
 <button onClick={handleResetTech} className="text-xs font-bold text-subtle hover:text-danger bg-surface-raised/50 px-2 py-1 min-h-[44px] flex items-center rounded transition-colors" title={t('input.resetDefaults')}>
 Reset
 </button>
 )
 }
 />
 
 {openSections.rates && (
 <div className="p-5 pt-0 space-y-4 animate-fade-in border-t border-edge mt-2 pt-4">
 <div className="bg-surface-alt/30 p-4 rounded-xl border border-edge space-y-3">
 <h4 className="text-xs font-bold uppercase text-subtle">{t('input.swissRates')}</h4>
 <div className="grid grid-cols-2 gap-3">
 <TechInput label={t('input.avsRate')} value={inputs.avsRate} onChange={(v) => handleChange('avsRate', v)} isPercentage step="0.1" />
 <TechInput label={t('input.acRate')} value={inputs.acRate} onChange={(v) => handleChange('acRate', v)} isPercentage step="0.1" />
 <TechInput label={t('input.laaRate')} value={inputs.laaRate} onChange={(v) => handleChange('laaRate', v)} isPercentage step="0.1" />
 <TechInput label={t('input.ijmRate')} value={inputs.ijmRate} onChange={(v) => handleChange('ijmRate', v)} isPercentage step="0.1" />
 </div>
 </div>
 <div className="bg-surface-alt/30 p-4 rounded-xl border border-edge space-y-3">
 <h4 className="text-xs font-bold uppercase text-subtle">{t('input.lppPension')}</h4>
 <div className="grid grid-cols-2 gap-3">
 <TechInput label={t('input.lppAge25_34')} value={inputs.lppRate25_34} onChange={(v) => handleChange('lppRate25_34', v)} isPercentage step="0.1" />
 <TechInput label={t('input.lppAge35_44')} value={inputs.lppRate35_44} onChange={(v) => handleChange('lppRate35_44', v)} isPercentage step="0.1" />
 <TechInput label={t('input.lppAge45_54')} value={inputs.lppRate45_54} onChange={(v) => handleChange('lppRate45_54', v)} isPercentage step="0.1" />
 <TechInput label={t('input.lppAge55plus')} value={inputs.lppRate55_plus} onChange={(v) => handleChange('lppRate55_plus', v)} isPercentage step="0.1" />
 </div>
 </div>
 <div className="bg-surface-alt/30 p-4 rounded-xl border border-edge space-y-3">
 <h4 className="text-xs font-bold uppercase text-subtle">{t('input.italy')}</h4>
 <div className="grid grid-cols-2 gap-3">
 <TechInput label={t('input.itSurchargeRate')} value={inputs.itAddizionaleRate} onChange={(v) => handleChange('itAddizionaleRate', v)} isPercentage step="0.1" />
 </div>
 </div>
 </div>
 )}
 </div>

 {/* Data privacy disclaimer */}
 <div className="flex items-start gap-2.5 mx-5 mb-5 p-3 bg-success-subtle rounded-xl border border-success-border">
 <Shield size={12} className="text-success flex-shrink-0 mt-0.5" />
 <p className="text-xs text-success leading-relaxed">{t('input.dataDisclaimer')}</p>
 </div>

 </div>
 )}

 {/* Easter egg toast — discreet bottom-right, rendered via portal */}
 {easterEgg && easterEggVisible && createPortal(
 <div className="fixed bottom-28 md:bottom-16 right-4 sm:right-6 z-[70] animate-fade-in cursor-pointer" role="button" tabIndex={0} onClick={dismissEasterEgg} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissEasterEgg(); } }} aria-label="Chiudi notifica">
 <div className="bg-surface-raised rounded-xl shadow-lg px-4 py-2.5 max-w-xs">
 <p className="text-xs font-medium text-body">{easterEgg}</p>
 </div>
 </div>,
 document.body
 )}
 </div>
 );
};

export const InputCard = React.memo(InputCardBase);
