import React, { useState, useCallback, Suspense, useEffect, useRef } from 'react';
import { ScrollText, Trophy, Armchair, Info, PartyPopper, Calculator, ChevronRight, Home, Briefcase, Heart, AlertCircle, ShoppingBag, ShieldCheck, User, Coins, Baby, TrainFront, Maximize2, Minimize2, Share2, Check, ArrowRight, Sliders, Bookmark, BookmarkCheck } from 'lucide-react';
// jsPDF and autoTable are lazy-imported inside exportPDF() — only needed on user click (~134KB gzip saved from critical path)
import { SimulationResult, TaxResult, TaxBreakdownItem, SimulationInputs } from '../../types';
import { lazyRetry } from '@/services/lazyRetry';
import DataFreshness from '@/components/shared/DataFreshness';
import { AD_SLOTS } from '@/services/adsenseSlots';
// ComparisonChart is lazy-loaded to avoid pulling vendor-charts (~114KB gzip) into the critical path
const ComparisonChart = lazyRetry(() => import('./ComparisonChart').then(m => ({ default: m.ComparisonChart })));
const SubscriptionCTA = lazyRetry(() => import('@/components/shared/SubscriptionCTA'));
const ConsultingCTA = lazyRetry(() => import('./ConsultingCTA').then(m => ({ default: m.ConsultingCTA })));
const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
const ShareableResultCard = lazyRetry(() => import('@/components/shared/ShareableResultCard'));
const CalculatorPaywall = lazyRetry(() => import('./CalculatorPaywall'));
import { shouldShowPaywallFromStorage, SIM_COMPLETE_COUNTER_KEY, VISIT_COUNTER_KEY } from './CalculatorPaywall';
import { Analytics } from '../../services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { useTranslation } from '../../services/i18n';
import { buildShareURL } from '../../services/urlStateService';
import { useNavigationOptional } from '@/services/NavigationContext';
import InlineNetDeltaBadge from './InlineNetDeltaBadge';

interface Props {
 result: SimulationResult;
 inputs: SimulationInputs;
 focusArea?: 'CH' | 'IT' | null;
 onProfileTagClick?: (field: 'age' | 'maritalStatus' | 'children') => void;
}

const formatCurrency = (value: number) => {
 return Math.abs(Math.round(value)).toLocaleString('it-IT');
};

const CurrencyValue: React.FC<{ value: number; currency: string; className?: string; smallCurrency?: boolean }> = ({ value, currency, className ="", smallCurrency }) => (
 <span className={`font-mono font-bold tracking-tight whitespace-nowrap tabular-nums ${className}`}>
 {!smallCurrency && (currency === 'EUR' ? '€ ' : 'CHF ')}
 {formatCurrency(value)}
 {smallCurrency && <span className="text-[0.7em] ml-1 font-sans font-normal text-muted">{currency}</span>}
 </span>
);

/* ── Stock-ticker net-delta feedback (FRO-107) ─────────────────────────────
 * Tracks the previous CHF net value and exposes an incrementing `key` so
 * the badge is remounted (re-animated) on every meaningful change.
 * ───────────────────────────────────────────────────────────────────────── */
function useNetDelta(value: number): { delta: number; key: number } {
 const prevRef = useRef<number | null>(null);
 const [state, setState] = useState<{ delta: number; key: number }>({ delta: 0, key: 0 });
 useEffect(() => {
 if (prevRef.current === null) {
 prevRef.current = value;
 return;
 }
 const diff = Math.round(value - prevRef.current);
 prevRef.current = value;
 if (Math.abs(diff) < 1) return; // ignore floating-point noise
 setState((s) => ({ delta: diff, key: s.key + 1 }));
 }, [value]);
 return state;
}

const getBreakdownColor = (label: string): string => {
 const l = label.toLowerCase();
 if (l.includes('netannual') || l.includes('net_annual') || l === 'calc.netannualincome') return 'bg-success-strong'; 
 if (l.includes('social') || l.includes('pension') || l.includes('contribut')) return 'bg-accent-strong'; 
 if (l.includes('health')) return 'bg-warning-strong'; 
 if (l.includes('tax') || l.includes('source') || l.includes('irpef') || l.includes('ssn')) return 'bg-surface-alt0'; 
 if (l.includes('expense')) return 'bg-warning';
 if (l.includes('income') || l.includes('allowance')) return 'bg-accent-strong'; 
 return 'bg-surface-raised';
};

const BreakdownTable: React.FC<{ data: TaxBreakdownItem[]; currency: string; showEUR?: boolean; exchangeRate?: number }> = ({ data, currency, showEUR, exchangeRate }) => {
 const { t } = useTranslation();
 const [mobileTooltipIdx, setMobileTooltipIdx] = useState<number | null>(null);
 const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
 const translateKey = (key: string): string => {
 if (!key) return '';
 // Handle double-pipe-separated multi-key descriptions:"key1||key2||key3"
 if (key.includes('||')) {
 return key.split('||').map(k => translateKey(k.trim())).filter(Boolean).join('. ');
 }
 // Handle pipe-delimited params:"calc.netIncomeDescCH|12.5|C" => translate key + append params
 const parts = key.split('|');
 const baseKey = parts[0];
 const translated = t(baseKey);
 // If translation found (different from key), format with params
 if (translated !== baseKey && parts.length > 1) {
 if (baseKey === 'calc.healthInsuranceDesc') {
 // params: [monthlyPerPerson, familyMembers]
 return `${translated} (CHF ${parts[1]}/mese × ${parts[2]} ${t('calc.familyMembers')})`;
 }
 return `${translated}. ${parts.slice(1).map((p, i) => i === 0 ? `${t('calc.estimatedRate')}: ${p}%` : `${t('calc.table')}: ${p}`).join('. ')}.`;
 }
 return translated;
 };
 return (
 <div className="w-full text-sm">
 {data.map((item, idx) => {
 const isTotal = idx === 0;
 const isNet = item.label === 'calc.netAnnualIncome';
 const isNegative = item.amount < 0;
 const dotColor = getBreakdownColor(item.label);
 const showMobileTooltip = mobileTooltipIdx === idx;
 const hasSubItems = item.subItems && item.subItems.length > 0;
 const isExpanded = expandedIdx === idx;

 return (
 <React.Fragment key={idx}>
 <div
 onClick={(e) => {
 if (hasSubItems) {
 e.stopPropagation();
 setExpandedIdx(prev => prev === idx ? null : idx);
 return;
 }
 if (!item.description) return;
 if (typeof window === 'undefined') return;
 const isTouchLike =
 window.matchMedia('(hover: none)').matches ||
 window.matchMedia('(pointer: coarse)').matches;
 if (!isTouchLike) return;
 e.stopPropagation();
 setMobileTooltipIdx((prev) => (prev === idx ? null : idx));
 }}
 className={`flex items-center justify-between py-3 border-b border-dashed border-edge last:border-0 hover:bg-surface-raised px-3 rounded-lg transition-colors group relative ${isNet ? 'bg-success-subtle/50 mt-2 rounded-xl border-none' : ''} ${hasSubItems ? 'cursor-pointer' : 'cursor-default'}`}
 >
 {/* Label Section */}
 <div className="flex-1 pr-3 flex items-center gap-2 min-w-0">
 {!isTotal && !isNet && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}></div>}
 <div className="flex items-center gap-1.5 min-w-0">
 <div className={`truncate transition-colors ${isTotal || isNet ? 'font-bold text-base text-heading' : 'font-medium text-subtle group-hover:text-heading'}`}>
 {translateKey(item.label)}
 </div>

 {hasSubItems && (
 <ChevronRight size={14} className={`text-muted flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
 )}

 {!isTotal && !hasSubItems && item.description && (
 <div className="group/tooltip relative inline-flex items-center flex-shrink-0">
 <Info size={12} className="text-muted cursor-help group-hover/tooltip:text-accent transition-colors" />
 <div className={`absolute bottom-full left-0 mb-2 ${showMobileTooltip ? 'block' : 'hidden'} group-hover/tooltip:block w-56 p-3 bg-surface-alt text-body text-xs font-medium rounded-xl shadow-2xl z-50 animate-fade-in border border-edge`}>
 {translateKey(item.description)}
 <div className="absolute top-full left-2 -translate-x-1/2 border-8 border-transparent border-t-heading"></div>
 </div>
 </div>
 )}
 </div>
 </div>

 {/* Value Section */}
 <div className="text-right flex items-center justify-end gap-3 flex-shrink-0">
 {item.percentage !== 0 && !isNet && (
 <div className="w-10 sm:w-12 text-xs font-bold text-subtle bg-surface-raised group-hover:bg-surface-raised/70 rounded px-1 py-0.5 text-center flex-shrink-0 transition-colors hidden sm:block">
 {Math.abs(item.percentage).toFixed(1)}%
 </div>
 )}
 <div className="flex flex-col items-end w-[110px]">
 {showEUR && currency === 'CHF' ? (
 <>
 <div className={`text-right font-mono font-bold whitespace-nowrap tabular-nums ${isNet ? 'text-lg text-success' : (isNegative ? 'text-danger' : 'text-strong')}`}>
 {isNegative ? '-' : ''} <CurrencyValue value={item.amountEUR !== undefined && item.amountEUR !== 0 ? Math.abs(item.amountEUR) : (exchangeRate ? Math.abs(item.amount) * exchangeRate : Math.abs(item.amount))} currency="EUR" />
 </div>
 <div className="text-xs font-mono text-muted font-medium whitespace-nowrap tabular-nums h-4">
 ≈ CHF {formatCurrency(Math.abs(item.amount))}
 </div>
 </>
 ) : (
 <>
 <div className={`text-right font-mono font-bold whitespace-nowrap tabular-nums ${isNet ? 'text-lg text-success' : (isNegative ? 'text-danger' : 'text-strong')}`}>
 {isNegative ? '-' : ''} <CurrencyValue value={item.amount} currency={currency} />
 </div>
 {showEUR && (
 <div className="text-xs font-mono text-muted font-medium whitespace-nowrap tabular-nums h-4">
 {item.amountEUR !== undefined && item.amountEUR !== 0 ? `≈ € ${formatCurrency(Math.abs(item.amountEUR))}` : ''}
 </div>
 )}
 </>
 )}
 </div>
 </div>
 </div>
 {/* Expandable IRPEF sub-items */}
 {hasSubItems && isExpanded && (
 <div className="ml-7 mr-3 mb-1 bg-surface-alt/40 rounded-xl border border-edge/50 overflow-hidden animate-fade-in">
 {item.subItems!.map((sub, si) => {
 const subNeg = sub.amountEUR < 0;
 return (
 <div key={si} className="flex items-center justify-between px-3 py-2 border-b border-dashed border-edge/30 last:border-0 text-xs">
 <span className="text-subtle font-medium">{translateKey(sub.label)}</span>
 <span className={`font-mono font-bold tabular-nums ${subNeg ? 'text-success' : 'text-danger'}`}>
 {subNeg ? '-' : '+'} € {formatCurrency(Math.abs(sub.amountEUR))}
 </span>
 </div>
 );
 })}
 </div>
 )}
 </React.Fragment>
 );
 })}
 </div>
 );
};

const ResultsViewBase: React.FC<Props> = ({ result, inputs, focusArea = null, onProfileTagClick }) => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
 const isDarkMode = nav?.isDarkMode;
 const isFocusMode = nav?.isFocusMode;
 const [showEUR, setShowEUR] = useState(false);
 const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');
 const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
 const [paywallOpen, setPaywallOpen] = useState(false);
 const [paywallEnabled, setPaywallEnabled] = useState(false);
 const chSectionRef = useRef<HTMLDivElement>(null);
 const itSectionRef = useRef<HTMLDivElement>(null);

 // E2 — Soft paywall trigger. Increment visit_count once per session, increment
 // counter_sim_complete on every mount (each time a fresh result is rendered).
 // Then, if the feature flag is on and the trigger rules match, open the modal
 // after a brief delay so the user has time to glance at the results.
 useEffect(() => {
 if (typeof window === 'undefined') return;
 // Visit counter — once per browser session.
 try {
 const SESSION_KEY = 'paywall_visit_counted';
 if (!sessionStorage.getItem(SESSION_KEY)) {
 const prev = parseInt(localStorage.getItem(VISIT_COUNTER_KEY) || '0', 10) || 0;
 localStorage.setItem(VISIT_COUNTER_KEY, String(prev + 1));
 sessionStorage.setItem(SESSION_KEY, '1');
 }
 } catch { /* storage blocked — ignore */ }
 // Simulation counter — every result mount counts as a completion.
 try {
 const prev = parseInt(localStorage.getItem(SIM_COMPLETE_COUNTER_KEY) || '0', 10) || 0;
 localStorage.setItem(SIM_COMPLETE_COUNTER_KEY, String(prev + 1));
 } catch { /* ignore */ }

 // Check RC flag (lazy import to avoid pulling firebase into critical path).
 let cancelled = false;
 (async () => {
 try {
 const { getConfigValue } = await import('@/services/firebase');
 const val = await getConfigValue('ENABLE_CALCULATOR_PAYWALL');
 if (!cancelled) setPaywallEnabled(val === 'true');
 } catch { /* RC unavailable — feature stays off */ }
 })();
 return () => { cancelled = true; };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 useEffect(() => {
 if (!paywallEnabled) return;
 if (paywallOpen) return;
 if (!shouldShowPaywallFromStorage()) return;
 const timer = setTimeout(() => setPaywallOpen(true), 2000);
 return () => clearTimeout(timer);
 }, [paywallEnabled, paywallOpen]);

 useEffect(() => {
 if (!focusArea) return;
 const target = focusArea === 'CH' ? chSectionRef.current : itSectionRef.current;
 if (!target) return;
 target.scrollIntoView({ behavior: 'smooth', block: 'start' });
 }, [focusArea]);

 // Share simulation via URL — 3-tier fallback (native share → clipboard → textarea)
 const handleShare = useCallback(async () => {
 const url = buildShareURL(inputs);
 const title = t('results.share.title');
 const text = t('results.share.text');

 try {
 if (navigator.share) {
 await navigator.share({ title, text, url });
 } else if (navigator.clipboard?.writeText) {
 await navigator.clipboard.writeText(url);
 setShareState('copied');
 setTimeout(() => setShareState('idle'), 2500);
 } else {
 const ta = document.createElement('textarea');
 ta.value = url;
 ta.style.position = 'fixed';
 ta.style.left = '-9999px';
 document.body.appendChild(ta);
 ta.select();
 document.execCommand('copy');
 document.body.removeChild(ta);
 setShareState('copied');
 setTimeout(() => setShareState('idle'), 2500);
 }
 Analytics.trackShare('link', 'simulation');
 } catch { /* user cancelled share dialog */ }
 }, [inputs, t]);

 // Save simulation to localStorage for later retrieval
 const handleSaveForLater = useCallback(() => {
 try {
 const savedSimulations = JSON.parse(localStorage.getItem('saved_simulations') || '[]') as Array<{ inputs: SimulationInputs; timestamp: number }>;
 const entry = { inputs: { ...inputs }, timestamp: Date.now() };
 // Keep max 10 saved simulations, newest first
 const updated = [entry, ...savedSimulations.filter(
 (s) => JSON.stringify(s.inputs) !== JSON.stringify(inputs)
 )].slice(0, 10);
 localStorage.setItem('saved_simulations', JSON.stringify(updated));
 setSaveState('saved');
 setTimeout(() => setSaveState('idle'), 2500);
 Analytics.trackUIInteraction('simulatore', 'results', 'save_for_later', 'click', undefined, 'calculator.results.save_for_later');
 } catch {
 // localStorage might be full — silently fail
 }
 }, [inputs]);

 const { chResident, itResident, savingsCHF, savingsEUR, exchangeRate, monthsBasis } = result;
 const isBetterFrontaliere = savingsCHF > 0;

 // Stock-ticker delta tracking (FRO-107) — only tracks CHF net, currency toggle doesn't trigger
 const chDelta = useNetDelta(chResident.netIncomeMonthly);
 const itDelta = useNetDelta(itResident.netIncomeMonthly);

 // --- Profile Tag Generator ---
 const getProfileTags = () => {
 const tags: Array<{
 label: string;
 icon: typeof User;
 color: string;
 bg: string;
 field?: 'age' | 'maritalStatus' | 'children';
 }> = [];

 // Tag 1: Age
 tags.push({ label: `${inputs.age} ${t('common.years')}`, icon: User, color: 'text-accent', bg: 'bg-accent-subtle', field: 'age' });

 // Tag 2: Marital Status & Spouse
 let statusLabel = '';
 if (inputs.maritalStatus === 'SINGLE') statusLabel = t('input.single');
 else if (inputs.maritalStatus === 'MARRIED') statusLabel = inputs.spouseWorks ? `${t('input.married')} (${t('input.spouseWorks')})` : t('input.married');
 else if (inputs.maritalStatus === 'DIVORCED') statusLabel = t('input.divorced');
 else statusLabel = t('input.widowed');
 tags.push({ label: statusLabel, icon: Heart, color: 'text-danger', bg: 'bg-danger-subtle', field: 'maritalStatus' });

 // Tag 3: Children
 if (inputs.children > 0) {
 tags.push({ label: t('input.childrenCount', { count: inputs.children }), icon: Baby, color: 'text-danger', bg: 'bg-danger-subtle', field: 'children' });
 } else {
 tags.push({ label: t('input.noChildren'), icon: Baby, color: 'text-muted', bg: 'bg-surface-raised', field: 'children' });
 }

 // Tag 4: Work Type
 const workLabel = inputs.frontierWorkerType === 'NEW' 
 ? `${t('input.newFrontShort')} (${inputs.distanceZone === 'WITHIN_20KM' ? '<20km' : '>20km'})` 
 : t('input.oldFrontShort');
 tags.push({ label: workLabel, icon: TrainFront, color: 'text-success', bg: 'bg-success-subtle' });

 // Tag 5: Income
 tags.push({ label: `RAL: CHF ${formatCurrency(inputs.annualIncomeCHF)}`, icon: Coins, color: 'text-warning', bg: 'bg-warning-subtle' });

 return tags;
 };
 
 const profileTags = getProfileTags();

 const exportPDF = async () => {
 // Analytics tracking
 Analytics.trackDownload('pdf', 'Report Comparison');
 
 try {
 // Lazy-load PDF libraries only when user clicks export (~134KB gzip)
 const [{ jsPDF }, { default: autoTable }] = await Promise.all([
 import('jspdf'),
 import('jspdf-autotable')
 ]);
 const doc = new jsPDF();
 
 // -- Header --
 doc.setFillColor(30, 41, 59); // Slate 800
 doc.rect(0, 0, 210, 40, 'F');
 
 doc.setTextColor(255, 255, 255);
 doc.setFontSize(22);
 doc.setFont('helvetica', 'bold');
 doc.text(t('results.pdf.title'), 14, 18);
 
 doc.setFontSize(10);
 doc.setFont('helvetica', 'normal');
 doc.setTextColor(148, 163, 184); // Slate 400
 doc.text(t('results.pdf.subtitle'), 14, 24);

 doc.setFontSize(10);
 doc.setTextColor(255, 255, 255);
 doc.text(`${t('results.pdf.generatedOn')} ${new Date().toLocaleDateString()}`, 150, 18);

 // -- Summary Box --
 doc.setFillColor(241, 245, 249); // Slate 100
 doc.setDrawColor(226, 232, 240); // Slate 200
 doc.roundedRect(14, 45, 182, 18, 2, 2, 'FD');
 
 doc.setFontSize(9);
 doc.setTextColor(71, 85, 105); // Slate 600
 doc.setFont('helvetica', 'bold');
 doc.text(`${t('results.pdf.profile')}:`, 18, 56);
 doc.setFont('helvetica', 'normal');
 // Create a simplified text string for PDF
 const pdfSummary = profileTags.map(tag => tag.label).join(' • ');
 doc.text(pdfSummary, 40, 56);

 // -- Comparison Table Data Prep --
 const bodyData = [
 [t('results.pdf.grossIncome'), `CHF ${formatCurrency(chResident.grossIncome)}`, `CHF ${formatCurrency(itResident.grossIncome)}`],
 [t('results.pdf.familyAllowance'), `+ CHF ${formatCurrency(chResident.familyAllowance)}`, `+ CHF ${formatCurrency(itResident.familyAllowance)}`],
 [t('results.pdf.socialDeductions'), `- CHF ${formatCurrency(Math.abs(chResident.socialContributions))}`, `- CHF ${formatCurrency(Math.abs(itResident.socialContributions))}`],
 [t('results.pdf.totalTaxes'), `- CHF ${formatCurrency(Math.abs(chResident.taxes))}`, `- CHF ${formatCurrency(Math.abs(itResident.taxes))}`],
 [t('results.pdf.healthInsurance'), `- CHF ${formatCurrency(Math.abs(chResident.healthInsurance))}`, `(${t('results.pdf.notDeducted')})`],
 [t('results.pdf.personalExpenses'), `- CHF ${formatCurrency(Math.abs(chResident.customExpensesTotal))}`, `- CHF ${formatCurrency(Math.abs(itResident.customExpensesTotal))}`],
 [t('results.pdf.netAnnualIncome'), `CHF ${formatCurrency(chResident.netIncomeAnnual)}`, `CHF ${formatCurrency(itResident.netIncomeAnnual)}`]
 ];

 // Add Pre-Tax Row for Italy if exists
 if (itResident.swissNetIncomeMonthlyCHF) {
 // Insert before Net Income (last index)
 bodyData.splice(6, 0, [t('results.pdf.swissNetPreTax'), '-', `CHF ${formatCurrency(itResident.swissNetIncomeMonthlyCHF * inputs.monthsBasis)}`]);
 }

 // -- Main Table --
 autoTable(doc, {
 startY: 70,
 head: [[t('results.pdf.headerItem'), t('results.pdf.headerSwiss'), t('results.pdf.headerFrontier')]],
 body: bodyData,
 theme: 'grid',
 headStyles: { 
 fillColor: [59, 130, 246], // Blue 500
 fontSize: 10,
 fontStyle: 'bold',
 halign: 'center'
 },
 columnStyles: {
 0: { cellWidth: 70, fontStyle: 'bold', textColor: [51, 65, 85] },
 1: { halign: 'right', textColor: [30, 58, 138] }, // Dark Blue
 2: { halign: 'right', textColor: [185, 28, 28] } // Dark Red
 },
 styles: {
 fontSize: 10,
 cellPadding: 6,
 lineColor: [226, 232, 240],
 lineWidth: 0.1
 },
 didParseCell: function(data) {
 // Style the Net Income Row
 if (data.row.index === bodyData.length - 1) {
 data.cell.styles.fontStyle = 'bold';
 data.cell.styles.fillColor = [236, 253, 245]; // Emerald 50
 data.cell.styles.textColor = [5, 150, 105]; // Emerald 600
 data.cell.styles.fontSize = 12;
 }
 // Style Pre-Tax Row
 if (data.row.cells[0].raw === t('results.pdf.swissNetPreTax')) {
 data.cell.styles.fillColor = [248, 250, 252];
 data.cell.styles.fontStyle = 'italic';
 }
 }
 });

 // -- Footer Notes --
 const finalY = (doc as any).lastAutoTable.finalY + 15;
 
 doc.setFontSize(12);
 doc.setTextColor(30, 41, 59);
 doc.setFont('helvetica', 'bold');
 
 // Winner Badge logic equivalent
 const winnerText = isBetterFrontaliere ? t('results.pdf.frontierWins') : t('results.pdf.residenceWins');
 const winnerColor = isBetterFrontaliere ? [22, 163, 74] : [37, 99, 235]; // Green or Blue
 
 doc.setTextColor(winnerColor[0], winnerColor[1], winnerColor[2]);
 doc.text(winnerText, 14, finalY);
 
 doc.setFontSize(10);
 doc.setTextColor(71, 85, 105);
 doc.setFont('helvetica', 'normal');
 doc.text(`${t('results.pdf.estimatedDifference')}: CHF ${formatCurrency(savingsCHF)} / ${t('results.pdf.year')}`, 14, finalY + 6);

 // Specific Notes Block — add new page if content would overflow A4 (297mm)
 const PAGE_H = 280; // safe bottom margin (297mm page - 17mm padding)
 const notesStartY = finalY + 45 > PAGE_H ? (doc.addPage(), 20) : finalY + 20;
 let noteY = notesStartY;
 doc.setFontSize(9);
 doc.setFont('helvetica', 'bold');
 doc.text(`${t('results.pdf.taxDetails')}:`, 14, noteY);

 doc.setFont('helvetica', 'normal');
 noteY += 6;
 const notes = [
 `${t('results.pdf.exchangeApplied')}: 1 CHF = ${inputs.customExchangeRate} EUR`,
 `${t('results.pdf.italyRegime')}: ${t(itResident.details.regime)}`,
 ...itResident.details.notes.map(n => t(n.split('|')[0]))
 ];

 notes.forEach(note => {
 if (noteY < PAGE_H - 15) {
 doc.text(`• ${note}`, 14, noteY);
 noteY += 5;
 }
 });

 // Legal Disclaimer — always at a safe distance below last note
 const disclaimerY = Math.min(Math.max(noteY + 8, 270), PAGE_H);
 doc.setFontSize(8);
 doc.setTextColor(148, 163, 184);
 doc.text(t('results.pdf.disclaimer'), 105, disclaimerY, { align: 'center' });

 doc.save(t('results.pdf.filename'));
 } catch (error) {
 reportCaughtError(error, 'results.pdfExport');
 }
 };

 return (
 <div className="bg-surface rounded-2xl shadow-sm border border-edge overflow-hidden flex flex-col h-full animate-fade-in-up transition-colors duration-300">
 <div className="p-5 bg-surface border-b border-edge flex justify-between items-start sm:items-center sticky top-0 z-10 gap-4 flex-col sm:flex-row">
 <div className="flex-1 w-full">
 <div className="flex justify-between items-center mb-2">
 <h2 className="text-lg font-bold font-display text-strong">{t('results.comparativeAnalysis')}</h2>
 {/* Action buttons - aligned together */}
 <div className="flex items-center gap-1">
 {/* CHF / EUR toggle switch */}
 <div className="flex items-center bg-surface-raised rounded-xl p-0.5 gap-0.5">
 <button
 onClick={() => setShowEUR(false)}
 className={`px-2.5 py-1.5 rounded-lg text-sm font-bold transition-[color,background-color,box-shadow] ${!showEUR ? 'bg-surface text-accent shadow-sm' : 'text-subtle hover:text-body'}`}
 aria-label={t('results.showCHF')}
 >
 CHF
 </button>
 <button
 onClick={() => setShowEUR(true)}
 className={`px-2.5 py-1.5 rounded-lg text-sm font-bold transition-[color,background-color,box-shadow] ${showEUR ? 'bg-surface text-warning shadow-sm' : 'text-subtle hover:text-body'}`}
 aria-label={t('results.showEUR')}
 >
 EUR
 </button>
 </div>
 {nav && (
 <button
 onClick={() => { const newFocus = !isFocusMode; nav.setIsFocusMode(newFocus); Analytics.trackFocusMode(newFocus); }}
 className={`p-2 rounded-xl transition-colors ${isFocusMode ? 'bg-accent-subtle text-link' : 'text-muted hover:bg-surface-raised'}`}
 title={isFocusMode ? t('results.detailedView') : t('results.conciseView')}
 aria-label={isFocusMode ? t('results.detailedView') : t('results.conciseView')}
 >
 {isFocusMode ? <Maximize2 size={20} /> : <Minimize2 size={20} />}
 </button>
 )}
 <button
 onClick={exportPDF}
 className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-warning-strong text-on-accent hover:bg-warning-strong-hover shadow-sm hover:shadow-md transition-[color,background-color,box-shadow] flex-shrink-0 focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 text-sm font-bold"
 title={t('results.downloadPDF')}
 aria-label={t('results.downloadPDF')}
 >
 <ScrollText size={14} />
 <span className="hidden sm:inline">Scarica PDF</span>
 </button>
 <button
 onClick={handleShare}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-colors flex-shrink-0 text-sm font-bold ${shareState === 'copied' ? 'text-success bg-success-subtle' : 'text-subtle hover:bg-surface-raised'}`}
 title={shareState === 'copied' ? t('results.share.copied') : t('results.share.button')}
 aria-label={t('results.share.button')}
 >
 {shareState === 'copied' ? <Check size={14} /> : <Share2 size={14} />}
 <span className="hidden sm:inline">{shareState === 'copied' ? t('results.share.copied') : t('results.share.buttonShort')}</span>
 </button>
 <button
 onClick={handleSaveForLater}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-colors flex-shrink-0 text-sm font-bold ${saveState === 'saved' ? 'text-warning bg-warning-subtle' : 'text-subtle hover:bg-surface-raised'}`}
 title={saveState === 'saved' ? t('results.save.saved') : t('results.save.button')}
 aria-label={t('results.save.button')}
 >
 {saveState === 'saved' ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
 <span className="hidden sm:inline">{saveState === 'saved' ? t('results.save.saved') : t('results.save.buttonShort')}</span>
 </button>
 </div>
 </div>
 
 {/* MODERN PROFILE TAGS */}
 <div className="flex flex-wrap gap-2">
 {profileTags.map((tag, idx) => (
 tag.field && onProfileTagClick ? (
 <button
 key={idx}
 type="button"
 onClick={() => onProfileTagClick(tag.field!)}
 className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide border border-transparent transition-transform active:scale-[0.98] ${tag.bg} ${tag.color} sm:cursor-default`}
 aria-label={tag.label}
 >
 <tag.icon size={12} strokeWidth={2.5} />
 <span className={`truncate ${tag.field === 'maritalStatus' ? 'max-w-[130px] sm:max-w-none' : 'max-w-[150px] sm:max-w-none'}`}>{tag.label}</span>
 </button>
 ) : (
 <div key={idx} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide border border-transparent ${tag.bg} ${tag.color}`}>
 <tag.icon size={12} strokeWidth={2.5} />
 <span className={`truncate ${tag.field === 'maritalStatus' ? 'max-w-[130px] sm:max-w-none' : 'max-w-[150px] sm:max-w-none'}`}>{tag.label}</span>
 </div>
 )
 ))}
 </div>
 </div>
 </div>

 <div className="p-4 sm:p-6 flex-grow overflow-y-auto custom-scrollbar bg-surface-alt/30">
 {/* Banner with Fun Animation */}
 <div data-testid="results-advantage-banner" className={`p-4 sm:p-6 rounded-3xl text-on-accent shadow-lg mb-8 relative overflow-hidden transition-colors duration-500 group ${
 isBetterFrontaliere
 ? 'bg-gradient-to-r from-success-strong via-info-strong to-success-strong'
 : 'bg-gradient-to-r from-accent-strong via-accent-strong to-accent-strong-hover'
 }`}>

 
 <div className="flex items-center gap-4 sm:gap-6 relative z-10">
 <div className="bg-on-accent/10 p-3 sm:p-4 rounded-2xl shrink-0 transition-transform group-hover:scale-110 duration-300">
 {isBetterFrontaliere ? <Trophy size={28} className="text-on-accent" /> : <Armchair size={28} className="text-on-accent" />}
 </div>
 <div className="min-w-0">
 <div className="flex items-center gap-2 mb-1">
 {/* Improved Wording */}
 <h3 className="text-xl sm:text-2xl font-bold font-display tracking-tight truncate">
 {isBetterFrontaliere ? t('results.frontierBetter') : t('results.swissBetter')}
 </h3>
 {isBetterFrontaliere && <PartyPopper size={24} className="animate-spin [animation-duration:1s] [animation-iteration-count:1] text-on-accent" />}
 </div>
 <div className="text-on-accent/90 font-medium flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
 <span>{t('results.netAdvantage')}</span>
 {showEUR ? (
 <>
 <span className="font-bold font-mono text-base sm:text-lg bg-on-accent/20 px-2 py-0.5 rounded-lg border border-on-accent/10 tabular-nums">
 € {formatCurrency(savingsEUR)}
 </span>
 <span className="font-bold font-mono text-base sm:text-lg bg-on-accent/10 px-2 py-0.5 rounded-lg border border-on-accent/10 tabular-nums">
 ≈ CHF {formatCurrency(savingsCHF)}
 </span>
 </>
 ) : (
 <span className="font-bold font-mono text-base sm:text-lg bg-on-accent/20 px-2 py-0.5 rounded-lg border border-on-accent/10 tabular-nums">
 CHF {formatCurrency(savingsCHF)}
 </span>
 )}
 </div>
 </div>
 </div>
 </div>
 
 {/* Comparison Grid: Changed from md:grid-cols-2 to xl:grid-cols-2 to allow full width on iPad/Tablets */}
 <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 mb-8">
 {/* SWITZERLAND COLUMN */}
 <div
 id="results-ch-section"
 ref={chSectionRef}
 className={`bg-surface rounded-3xl p-4 sm:p-6 shadow-sm border relative group transition-[box-shadow,border-color] hover:shadow-md ${
 focusArea === 'CH'
 ? 'border-accent-border ring-2 ring-accent-border'
 : 'border-edge'
 }`}
 >
 <div className="absolute top-0 left-0 w-1 h-full bg-accent-strong"></div>
 <div className="flex justify-between items-start mb-6">
 <div>
 <div className="text-xs font-bold text-accent uppercase tracking-widest mb-1 bg-accent-subtle px-2 py-0.5 rounded-full inline-block">{t('results.liveInTicino')}</div>
 <div className="text-xl font-bold font-display text-strong">{t('results.switzerland')}</div>
 </div>
 <img src="https://flagcdn.com/w80/ch.png" className="w-8 rounded opacity-90" alt="CH" width={32} height={21} loading="lazy" />
 </div>

 <div className="space-y-4">
 <div className="bg-accent-subtle/50 p-4 rounded-2xl border border-accent-border/50">
 <div className="text-sm text-accent font-bold uppercase mb-1">{t('results.netMonthlyResidual')}</div>
 <div className="flex items-center gap-2 flex-wrap">
 {showEUR ? (
 <div className="text-2xl font-bold text-accent">
 <CurrencyValue value={Math.round(chResident.netIncomeMonthly * exchangeRate)} currency="EUR" />
 </div>
 ) : (
 <div className="text-2xl font-bold text-accent">
 <CurrencyValue value={chResident.netIncomeMonthly} currency="CHF" />
 </div>
 )}
 {chDelta.key > 0 && <InlineNetDeltaBadge key={chDelta.key} delta={chDelta.delta} />}
 </div>
 {showEUR && (
 <div className="text-sm font-mono text-accent/70 mt-0.5 tabular-nums">
 ≈ CHF {formatCurrency(chResident.netIncomeMonthly)}
 </div>
 )}
 </div>
 {!isFocusMode && (
 <>
 <BreakdownTable data={chResident.breakdown} currency="CHF" showEUR={showEUR} exchangeRate={exchangeRate} />
 {chResident.details.notes.length > 0 && (
 <div className="mt-4 p-3 bg-surface-alt/50 rounded-xl border border-dashed border-edge">
 <p className="text-xs font-bold uppercase text-muted mb-1">{t('results.notes')}</p>
 <ul className="text-xs text-muted list-disc list-inside">
 {chResident.details.notes.map((note, i) => <li key={i}>{t(note.split('|')[0])}</li>)}
 </ul>
 </div>
 )}
 </>
 )}
 </div>
 </div>

 {/* ITALY COLUMN */}
 <div
 id="results-it-section"
 ref={itSectionRef}
 className={`bg-surface rounded-3xl p-4 sm:p-6 shadow-sm border relative group transition-[box-shadow,border-color] hover:shadow-md ${
 focusArea === 'IT'
 ? 'border-success-border ring-2 ring-success-border'
 : 'border-edge'
 }`} > <div className="absolute top-0 left-0 w-1 h-full bg-danger-strong"></div> <div className="flex justify-between items-start mb-6"> <div> <div className="text-xs font-bold text-danger uppercase tracking-widest mb-1 bg-danger-subtle px-2 py-0.5 rounded-full inline-block">{t('results.liveInItaly')}</div> <div className="text-xl font-bold font-display text-heading">{t('results.italy')}</div> </div> <img src="https://flagcdn.com/w80/it.png" className="w-8 rounded opacity-90" alt="IT" width={32} height={21} loading="lazy" /> </div> <div className="space-y-4"> <div className="bg-danger-subtle/50 p-4 rounded-2xl border border-danger-border/50"> <div className="text-xs text-danger font-bold uppercase mb-1">{t('results.netMonthlyResidual')}</div> <div className="flex items-center gap-2 flex-wrap"> {showEUR ? ( <div className="text-2xl font-bold text-danger"> <CurrencyValue value={Math.round(itResident.netIncomeMonthly * exchangeRate)} currency="EUR" /> </div> ) : ( <div className="text-2xl font-bold text-danger"> <CurrencyValue value={itResident.netIncomeMonthly} currency="CHF" /> </div> )} {itDelta.key > 0 && <InlineNetDeltaBadge key={itDelta.key} delta={itDelta.delta} />} </div> {showEUR && ( <div className="text-sm font-mono text-danger/70 mt-0.5 tabular-nums"> ≈ CHF {formatCurrency(itResident.netIncomeMonthly)} </div> )} </div> {!isFocusMode && ( <> <BreakdownTable data={itResident.breakdown} currency="CHF" showEUR exchangeRate={exchangeRate} /> {/* MOVED BLOCK: Swiss Net Salary (Pre-Italian Tax) */} {itResident.swissNetIncomeMonthlyCHF && ( <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge mt-2 relative overflow-hidden"> <div className="text-xs text-muted font-bold uppercase mb-1 relative z-10"> {t('results.swissPayslipNet')} </div> <div className="text-xl font-bold text-body relative z-10"> <CurrencyValue value={itResident.swissNetIncomeMonthlyCHF} currency="CHF" /> </div> <ul className="mt-3 space-y-1.5 relative z-10"> {itResident.details.regime ==="calc.regime.newFrontier" ? ( <> <li className="text-xs text-muted font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-accent-strong"></div> {t('results.concurrentTax')}</li> {itResident.details.franchigiaEUR ? ( <li className="text-xs text-muted font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-success-strong"></div> {t('results.franchiseApplied', { amount: formatCurrency(itResident.details.franchigiaEUR) })}</li> ) : null} </> ) : ( <li className="text-xs text-muted font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-success-strong"></div> {t('results.exclusiveSwissTax')}</li> )} </ul> </div> )} {itResident.details.notes.length > 0 && ( <div className="mt-4 p-3 bg-surface-alt/50 rounded-xl border border-dashed border-edge"> <p className="text-xs font-bold uppercase text-muted mb-1">{t('results.notes')}</p> <ul className="text-xs text-muted list-disc list-inside"> {itResident.details.notes.map((note, i) => <li key={i}>{t(note.split('|')[0])}</li>)} </ul> </div> )} </> )} </div> </div> </div> {!isFocusMode && ( <> {/* WHY CHOOSE ONE OR THE OTHER? */} <div className="mb-8"> <h3 className="text-xs font-bold text-muted uppercase tracking-widest mb-6 flex items-center gap-2"> <Heart size={14} className="text-danger" /> {t('results.whyConvenient')} </h3> <div className="grid grid-cols-1 lg:grid-cols-2 gap-8"> {/* Pros Svizzera */} <div className="bg-gradient-to-br from-accent-subtle to-surface p-4 sm:p-6 rounded-3xl border border-accent-border shadow-sm"> <h4 className="flex items-center gap-2 text-accent font-bold mb-4"> <ShieldCheck size={18} className="text-accent" /> {t('results.chooseSwissIf')} </h4> <ul className="space-y-3 text-sm text-subtle font-medium"> <li className="flex gap-3"><ChevronRight size={14} className="text-accent shrink-0" /> <span><b>{t('results.ch.quality.title')}</b> {t('results.ch.quality')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-accent shrink-0" /> <span><b>{t('results.ch.career.title')}</b> {t('results.ch.career')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-accent shrink-0" /> <span><b>{t('results.ch.time.title')}</b> {t('results.ch.time')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-accent shrink-0" /> <span><b>{t('results.ch.purchasing.title')}</b> {t('results.ch.purchasing')}</span></li> </ul> </div> {/* Pros Italia */} <div className="bg-gradient-to-br from-success-subtle to-surface p-4 sm:p-6 rounded-3xl border border-success-border shadow-sm"> <h4 className="flex items-center gap-2 text-success font-bold mb-4"> <ShoppingBag size={18} className="text-success" /> {t('results.chooseItalyIf')} </h4> <ul className="space-y-3 text-sm text-subtle font-medium"> <li className="flex gap-3"><ChevronRight size={14} className="text-success shrink-0" /> <span><b>{t('results.it.cost.title')}</b> {t('results.it.cost')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-success shrink-0" /> <span><b>{t('results.it.property.title')}</b> {t('results.it.property')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-success shrink-0" /> <span><b>{t('results.it.social.title')}</b> {t('results.it.social')}</span></li> <li className="flex gap-3"><ChevronRight size={14} className="text-success shrink-0" /> <span><b>{t('results.it.tax.title')}</b> {t('results.it.tax')}</span></li> </ul> </div> </div> {/* Critical Warning */} <div className="mt-6 p-4 bg-warning-subtle border border-warning-border rounded-2xl flex gap-3"> <AlertCircle size={20} className="text-warning shrink-0" /> <div className="text-sm text-warning leading-relaxed font-medium"> <b>{t('results.notaBene')}</b> {t('results.disclaimer.housing')} </div> </div> </div> </> )} <div className="mb-8"> <h3 className="text-xs font-bold text-muted uppercase tracking-widest mb-4 flex items-center gap-2"> <Calculator size={14} className="text-accent" /> {t('results.monthlyReservesChart')} </h3> <Suspense fallback={<div className="h-64 bg-surface-raised rounded-xl animate-pulse" />}> <ComparisonChart result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} /> </Suspense> </div> {/* Shareable result card */} <Suspense fallback={null}> <ShareableResultCard title={t('results.shareTitle') || 'Simulazione Stipendio Netto'} subtitle={`${inputs.annualIncomeCHF?.toLocaleString('it-IT') || '0'} CHF/anno`}
 rows={[
 { label: t('results.net.chf') || 'Netto CH (CHF)', value: `CHF ${formatCurrency(chResident.netIncomeAnnual)}`, highlight: true, color: 'blue' },
 { label: t('results.net.eur') || 'Netto IT (EUR)', value: `€ ${formatCurrency(Math.round(itResident.netIncomeAnnual * exchangeRate))}`, highlight: true, color: 'emerald' },
 { label: t('results.taxes.ch') || 'Imposte CH', value: `CHF ${formatCurrency(Math.abs(chResident.taxes))}` },
 { label: t('results.taxes.it') || 'Imposte IT', value: `€ ${formatCurrency(Math.abs(Math.round(itResident.taxes * exchangeRate)))}` },
 ]}
 accent="blue"
 context="salary-simulation"
 />
 </Suspense>

 {/* Compare scenarios CTA — drives users from 'calculate' to 'compare' funnel step */}
 {nav && (
 <div className="mb-6 group">
 <button
 type="button"
 aria-label={t('results.compareCta.button')}
 onClick={() => {
 Analytics.trackFunnelStep('compare', { funnel: 'calculator', source: 'results_cta' });
 Analytics.trackCtaClick('calculator.results.compare_cta', {
 component: 'ResultsView',
 section: 'results',
 label: 'compare_scenarios',
 });
 nav.navigateTo('calculator', 'whatif');
 }}
 className="w-full text-left rounded-2xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-5 sm:p-6 shadow-sm hover:shadow-md hover:border-info-border transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
 >
 <div className="flex items-start gap-4">
 <div className="shrink-0 w-10 h-10 rounded-xl bg-info-subtle flex items-center justify-center text-info group-hover:bg-info-subtle transition-colors">
 <Sliders size={20} />
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-sm font-bold text-info mb-1">
 {t('results.compareCta.title')}
 </p>
 <p className="text-sm text-subtle leading-relaxed">
 {t('results.compareCta.subtitle')}
 </p>
 <div className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-info group-hover:gap-2.5 transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150">
 {t('results.compareCta.button')} <ArrowRight size={14} />
 </div>
 </div>
 </div>
 <p className="mt-3 text-xs text-subtle border-t border-accent-border pt-2.5">
 {t('results.compareCta.hint')}
 </p>
 </button>
 </div>
 )}

 {/* E3: Post-simulation consulting CTA — inline box pointing to /consulenza */}
 <Suspense fallback={null}>
 <ConsultingCTA />
 </Suspense>

 {/* Source methodology — AI SEO citability */}
 <div className="mt-6 p-4 bg-surface-alt/50 rounded-xl border border-edge">
 <p className="text-sm text-muted leading-relaxed">
 <strong>{t('results.methodology.title')}</strong>{' '}
 {t('results.methodology.description')}
 </p>
 </div>

 {/* Post-calculation newsletter CTA */}
 <Suspense fallback={null}>
 <SubscriptionCTA />
 </Suspense>

 {/* AdSense: in-page multiplex after high-intent simulation_complete moment */}
 <Suspense fallback={null}>
 <AdSenseBanner
 adSlot={AD_SLOTS.CALCULATOR_POST_RESULT.slot}
 adFormat={AD_SLOTS.CALCULATOR_POST_RESULT.format}
 fullWidthResponsive={AD_SLOTS.CALCULATOR_POST_RESULT.fullWidthResponsive}
 className="my-6"
 />
 </Suspense>

 {/* SEO: Internal cross-links to related tools */}
 <Suspense fallback={null}>
 <RelatedTools context="salary" />
 </Suspense>
 </div>
 {/* E2 — Soft paywall (PDF report email capture) */}
 {paywallOpen && (
 <Suspense fallback={null}>
 <CalculatorPaywall
 result={result}
 inputs={inputs}
 onClose={() => setPaywallOpen(false)}
 />
 </Suspense>
 )}
 </div>
 );
};

export const ResultsView = React.memo(ResultsViewBase);
