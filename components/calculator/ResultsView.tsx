import React, { useState, useCallback, Suspense, useEffect, useRef } from 'react';
import { ScrollText, Trophy, Armchair, Info, PartyPopper, Calculator, ChevronRight, Home, Briefcase, Heart, AlertCircle, ShoppingBag, ShieldCheck, User, Coins, Baby, TrainFront, Maximize2, Minimize2, Share2, Check, ArrowRight, Sliders } from 'lucide-react';
// jsPDF and autoTable are lazy-imported inside exportPDF() — only needed on user click (~134KB gzip saved from critical path)
import { SimulationResult, TaxResult, TaxBreakdownItem, SimulationInputs } from '../../types';
import { lazyRetry } from '@/services/lazyRetry';
import DataFreshness from '@/components/shared/DataFreshness';
// ComparisonChart is lazy-loaded to avoid pulling vendor-charts (~114KB gzip) into the critical path
const ComparisonChart = lazyRetry(() => import('./ComparisonChart').then(m => ({ default: m.ComparisonChart })));
const SubscriptionCTA = lazyRetry(() => import('@/components/shared/SubscriptionCTA'));
const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
const ShareableResultCard = lazyRetry(() => import('@/components/shared/ShareableResultCard'));
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

const CurrencyValue: React.FC<{ value: number; currency: string; className?: string; smallCurrency?: boolean }> = ({ value, currency, className = "", smallCurrency }) => (
  <span className={`font-mono font-bold tracking-tight whitespace-nowrap tabular-nums ${className}`}>
    {!smallCurrency && (currency === 'EUR' ? '€ ' : 'CHF ')}
    {formatCurrency(value)}
    {smallCurrency && <span className="text-[0.7em] ml-1 font-sans font-normal text-slate-500 dark:text-slate-400">{currency}</span>}
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
  if (l.includes('netannual') || l.includes('net_annual') || l === 'calc.netannualincome') return 'bg-emerald-500'; 
  if (l.includes('social') || l.includes('pension') || l.includes('contribut')) return 'bg-violet-500'; 
  if (l.includes('health')) return 'bg-amber-500'; 
  if (l.includes('tax') || l.includes('source') || l.includes('irpef') || l.includes('ssn')) return 'bg-slate-500'; 
  if (l.includes('expense')) return 'bg-orange-400';
  if (l.includes('income') || l.includes('allowance')) return 'bg-blue-500'; 
  return 'bg-slate-200 dark:bg-slate-700';
};

const BreakdownTable: React.FC<{ data: TaxBreakdownItem[]; currency: string; showEUR?: boolean; exchangeRate?: number }> = ({ data, currency, showEUR, exchangeRate }) => {
  const { t } = useTranslation();
  const [mobileTooltipIdx, setMobileTooltipIdx] = useState<number | null>(null);
  const translateKey = (key: string): string => {
    if (!key) return '';
    // Handle double-pipe-separated multi-key descriptions: "key1||key2||key3"
    if (key.includes('||')) {
      return key.split('||').map(k => translateKey(k.trim())).filter(Boolean).join('. ');
    }
    // Handle pipe-delimited params: "calc.netIncomeDescCH|12.5|C" => translate key + append params
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
      
      return (
        <div
          key={idx}
          onClick={(e) => {
            if (!item.description) return;
            if (typeof window === 'undefined') return;
            const isTouchLike =
              window.matchMedia('(hover: none)').matches ||
              window.matchMedia('(pointer: coarse)').matches;
            if (!isTouchLike) return;
            e.stopPropagation();
            setMobileTooltipIdx((prev) => (prev === idx ? null : idx));
          }}
          className={`flex items-center justify-between py-3 border-b border-dashed border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50/80 dark:hover:bg-slate-800/80 px-3 rounded-lg transition-colors group cursor-default relative ${isNet ? 'bg-emerald-50/50 dark:bg-emerald-900/10 mt-2 rounded-xl border-none' : ''}`}
        >
          {/* Label Section */}
          <div className="flex-1 pr-3 flex items-center gap-2 min-w-0">
            {!isTotal && !isNet && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}></div>}
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={`truncate transition-colors ${isTotal || isNet ? 'font-bold text-base text-slate-900 dark:text-slate-100' : 'font-medium text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-200'}`}>
                {translateKey(item.label)}
              </div>
              
              {!isTotal && item.description && (
                <div className="group/tooltip relative inline-flex items-center flex-shrink-0">
                  <Info size={12} className="text-slate-500 dark:text-slate-400 cursor-help group-hover/tooltip:text-indigo-500 transition-colors" />
                  <div className={`absolute bottom-full left-0 mb-2 ${showMobileTooltip ? 'block' : 'hidden'} group-hover/tooltip:block w-56 p-3 bg-slate-900 dark:bg-slate-800 text-white text-xs font-medium rounded-xl shadow-2xl z-50 animate-fade-in border border-slate-700`}>
                    {translateKey(item.description)}
                    <div className="absolute top-full left-2 -translate-x-1/2 border-8 border-transparent border-t-slate-900 dark:border-t-slate-800"></div>
                  </div>
                </div>
              )}
            </div>
          </div>
          
          {/* Value Section */}
          <div className="text-right flex items-center justify-end gap-3 flex-shrink-0">
             {item.percentage !== 0 && !isNet && (
                <div className="w-10 sm:w-12 text-xs font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 group-hover:bg-slate-200/70 rounded px-1 py-0.5 text-center flex-shrink-0 transition-colors hidden sm:block">
                  {Math.abs(item.percentage).toFixed(1)}%
                </div>
             )}
             <div className="flex flex-col items-end w-[110px]">
                {showEUR && currency === 'CHF' ? (
                  <>
                    <div className={`text-right font-mono font-bold whitespace-nowrap tabular-nums ${isNet ? 'text-lg text-emerald-700 dark:text-emerald-400' : (isNegative ? 'text-red-700 dark:text-red-400' : 'text-slate-800 dark:text-slate-100')}`}>
                        {isNegative ? '-' : ''} <CurrencyValue value={item.amountEUR !== undefined && item.amountEUR !== 0 ? Math.abs(item.amountEUR) : (exchangeRate ? Math.abs(item.amount) * exchangeRate : Math.abs(item.amount))} currency="EUR" />
                    </div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap tabular-nums h-4">
                       ≈ CHF {formatCurrency(Math.abs(item.amount))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={`text-right font-mono font-bold whitespace-nowrap tabular-nums ${isNet ? 'text-lg text-emerald-700 dark:text-emerald-400' : (isNegative ? 'text-red-700 dark:text-red-400' : 'text-slate-800 dark:text-slate-100')}`}>
                        {isNegative ? '-' : ''} <CurrencyValue value={item.amount} currency={currency} />
                    </div>
                    {showEUR && (
                        <div className="text-xs font-mono text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap tabular-nums h-4">
                           {item.amountEUR !== undefined && item.amountEUR !== 0 ? `≈ € ${formatCurrency(Math.abs(item.amountEUR))}` : ''}
                        </div>
                    )}
                  </>
                )}
             </div>
          </div>
        </div>
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
  const chSectionRef = useRef<HTMLDivElement>(null);
  const itSectionRef = useRef<HTMLDivElement>(null);

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
    tags.push({ label: `${inputs.age} ${t('common.years')}`, icon: User, color: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', field: 'age' });

    // Tag 2: Marital Status & Spouse
    let statusLabel = '';
    if (inputs.maritalStatus === 'SINGLE') statusLabel = t('input.single');
    else if (inputs.maritalStatus === 'MARRIED') statusLabel = inputs.spouseWorks ? `${t('input.married')} (${t('input.spouseWorks')})` : t('input.married');
    else if (inputs.maritalStatus === 'DIVORCED') statusLabel = t('input.divorced');
    else statusLabel = t('input.widowed');
    tags.push({ label: statusLabel, icon: Heart, color: 'text-rose-700 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', field: 'maritalStatus' });

    // Tag 3: Children
    if (inputs.children > 0) {
      tags.push({ label: t('input.childrenCount', { count: inputs.children }), icon: Baby, color: 'text-pink-700 dark:text-pink-400', bg: 'bg-pink-50 dark:bg-pink-900/20', field: 'children' });
    } else {
        tags.push({ label: t('input.noChildren'), icon: Baby, color: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800', field: 'children' });
    }

    // Tag 4: Work Type
    const workLabel = inputs.frontierWorkerType === 'NEW' 
        ? `${t('input.newFrontShort')} (${inputs.distanceZone === 'WITHIN_20KM' ? '<20km' : '>20km'})` 
        : t('input.oldFrontShort');
    tags.push({ label: workLabel, icon: TrainFront, color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' });

    // Tag 5: Income
    tags.push({ label: `RAL: CHF ${formatCurrency(inputs.annualIncomeCHF)}`, icon: Coins, color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' });

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
              2: { halign: 'right', textColor: [185, 28, 28] }  // Dark Red
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
                  data.cell.styles.textColor = [5, 150, 105];   // Emerald 600
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

      // Specific Notes Block
      let noteY = finalY + 20;
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
          doc.text(`• ${note}`, 14, noteY);
          noteY += 5;
      });

      // Legal Disclaimer
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(t('results.pdf.disclaimer'), 105, 285, { align: 'center' });

      doc.save(t('results.pdf.filename'));
    } catch (error) {
      reportCaughtError(error, 'results.pdfExport');
    }
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col h-full animate-fade-in-up transition-colors duration-300">
      <div className="p-5 bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-800 flex justify-between items-start sm:items-center sticky top-0 z-10 gap-4 flex-col sm:flex-row">
        <div className="flex-1 w-full">
           <div className="flex justify-between items-center mb-2">
             <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('results.comparativeAnalysis')}</h2>
             {/* Action buttons - aligned together */}
             <div className="flex items-center gap-1">
               {/* CHF / EUR toggle switch */}
               <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-xl p-0.5 gap-0.5">
                 <button
                   onClick={() => setShowEUR(false)}
                   className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-[color,background-color,box-shadow] ${!showEUR ? 'bg-white dark:bg-slate-700 text-blue-700 dark:text-blue-300 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                   aria-label={t('results.showCHF')}
                 >
                   CHF
                 </button>
                 <button
                   onClick={() => setShowEUR(true)}
                   className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-[color,background-color,box-shadow] ${showEUR ? 'bg-white dark:bg-slate-700 text-amber-700 dark:text-amber-300 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                   aria-label={t('results.showEUR')}
                 >
                   EUR
                 </button>
               </div>
               {nav && (
                 <button
                   onClick={() => { const newFocus = !isFocusMode; nav.setIsFocusMode(newFocus); Analytics.trackFocusMode(newFocus); }}
                   className={`p-2 rounded-xl transition-colors ${isFocusMode ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                   title={isFocusMode ? t('results.detailedView') : t('results.conciseView')}
                   aria-label={isFocusMode ? t('results.detailedView') : t('results.conciseView')}
                 >
                   {isFocusMode ? <Maximize2 size={20} /> : <Minimize2 size={20} />}
                 </button>
               )}
               <button 
                 onClick={exportPDF} 
                 className="p-2 rounded-xl text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-[color,background-color,box-shadow] flex-shrink-0 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                 title={t('results.downloadPDF')}
                 aria-label={t('results.downloadPDF')}
               >
                 <ScrollText size={20} />
               </button>
               <button
                 onClick={handleShare}
                 className={`p-2 rounded-xl transition-colors flex-shrink-0 ${shareState === 'copied' ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20' : 'text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                 title={shareState === 'copied' ? t('results.share.copied') : t('results.share.button')}
                 aria-label={t('results.share.button')}
               >
                 {shareState === 'copied' ? <Check size={20} /> : <Share2 size={20} />}
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

      <div className="p-4 sm:p-6 flex-grow overflow-y-auto custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
        {/* Banner with Fun Animation */}
        <div className={`p-4 sm:p-6 rounded-3xl text-white shadow-lg mb-8 relative overflow-hidden transition-colors duration-500 group ${
            isBetterFrontaliere 
            ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600' 
            : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700'
        }`}>

           
           <div className="flex items-center gap-4 sm:gap-6 relative z-10">
              <div className="bg-white/10 p-3 sm:p-4 rounded-2xl shrink-0 transition-transform group-hover:scale-110 duration-300">
                {isBetterFrontaliere ? <Trophy size={28} className="text-yellow-300" /> : <Armchair size={28} className="text-indigo-200" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                   {/* Improved Wording */}
                   <h3 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                     {isBetterFrontaliere ? t('results.frontierBetter') : t('results.swissBetter')}
                   </h3>
                   {isBetterFrontaliere && <PartyPopper size={24} className="animate-spin [animation-duration:1s] [animation-iteration-count:1] text-yellow-300" />}
                </div>
                <div className="text-white/90 font-medium flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span>{t('results.netAdvantage')}</span>
                  {showEUR ? (
                    <>
                      <span className="font-bold font-mono text-base sm:text-lg bg-white/20 px-2 py-0.5 rounded-lg border border-white/10 tabular-nums">
                          € {formatCurrency(savingsEUR)}
                      </span>
                      <span className="font-bold font-mono text-base sm:text-lg bg-white/10 px-2 py-0.5 rounded-lg border border-white/10 tabular-nums">
                        ≈ CHF {formatCurrency(savingsCHF)}
                      </span>
                    </>
                  ) : (
                    <span className="font-bold font-mono text-base sm:text-lg bg-white/20 px-2 py-0.5 rounded-lg border border-white/10 tabular-nums">
                        CHF {formatCurrency(savingsCHF)}
                    </span>
                  )}
                </div>
              </div>
           </div>
        </div>
        
        {/* Comparison Grid: Changed from md:grid-cols-2 to xl:grid-cols-2 to allow full width on iPad/Tablets */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
          {/* SWITZERLAND COLUMN */}
          <div
            id="results-ch-section"
            ref={chSectionRef}
            className={`bg-white dark:bg-slate-800 rounded-3xl p-4 sm:p-6 shadow-sm border relative group transition-[box-shadow,border-color] hover:shadow-md ${
              focusArea === 'CH'
                ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-200/80 dark:ring-blue-900/60'
                : 'border-slate-100 dark:border-slate-700'
            }`}
          >
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-widest mb-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full inline-block">{t('results.liveInTicino')}</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('results.switzerland')}</div>
               </div>
               <img src="https://flagcdn.com/w80/ch.png" className="w-8 rounded opacity-90" alt="CH" width={32} height={21} loading="lazy" />
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50/50 dark:bg-blue-900/20 p-4 rounded-2xl border border-blue-100 dark:border-blue-800/50">
                <div className="text-xs text-blue-700 dark:text-blue-400 font-bold uppercase mb-1">{t('results.netMonthlyResidual')}</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {showEUR ? (
                    <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                      <CurrencyValue value={Math.round(chResident.netIncomeMonthly * exchangeRate)} currency="EUR" />
                    </div>
                  ) : (
                    <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                      <CurrencyValue value={chResident.netIncomeMonthly} currency="CHF" />
                    </div>
                  )}
                  {chDelta.key > 0 && <InlineNetDeltaBadge key={chDelta.key} delta={chDelta.delta} />}
                </div>
                {showEUR && (
                  <div className="text-sm font-mono text-blue-600/70 dark:text-blue-400/70 mt-0.5 tabular-nums">
                    ≈ CHF {formatCurrency(chResident.netIncomeMonthly)}
                  </div>
                )}
              </div>
              {!isFocusMode && (
                <>
                  <BreakdownTable data={chResident.breakdown} currency="CHF" showEUR={showEUR} exchangeRate={exchangeRate} />
                  {chResident.details.notes.length > 0 && (
                    <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                        <p className="text-xs font-bold uppercase text-slate-500 dark:text-slate-400 mb-1">{t('results.notes')}</p>
                        <ul className="text-xs text-slate-500 dark:text-slate-400 list-disc list-inside">
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
            className={`bg-white dark:bg-slate-800 rounded-3xl p-4 sm:p-6 shadow-sm border relative group transition-[box-shadow,border-color] hover:shadow-md ${
              focusArea === 'IT'
                ? 'border-emerald-400 dark:border-emerald-500 ring-2 ring-emerald-200/80 dark:ring-emerald-900/60'
                : 'border-slate-100 dark:border-slate-700'
            }`}
          >
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-xs font-bold text-red-700 dark:text-red-400 uppercase tracking-widest mb-1 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full inline-block">{t('results.liveInItaly')}</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('results.italy')}</div>
               </div>
               <img src="https://flagcdn.com/w80/it.png" className="w-8 rounded opacity-90" alt="IT" width={32} height={21} loading="lazy" />
            </div>

            <div className="space-y-4">
              <div className="bg-red-50/50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800/50">
                <div className="text-xs text-red-700 dark:text-red-400 font-bold uppercase mb-1">{t('results.netMonthlyResidual')}</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {showEUR ? (
                    <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                      <CurrencyValue value={Math.round(itResident.netIncomeMonthly * exchangeRate)} currency="EUR" />
                    </div>
                  ) : (
                    <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                      <CurrencyValue value={itResident.netIncomeMonthly} currency="CHF" />
                    </div>
                  )}
                  {itDelta.key > 0 && <InlineNetDeltaBadge key={itDelta.key} delta={itDelta.delta} />}
                </div>
                {showEUR && (
                  <div className="text-sm font-mono text-red-600/70 dark:text-red-400/70 mt-0.5 tabular-nums">
                    ≈ CHF {formatCurrency(itResident.netIncomeMonthly)}
                  </div>
                )}
              </div>

              {!isFocusMode && (
                <>
                  <BreakdownTable data={itResident.breakdown} currency="CHF" showEUR exchangeRate={exchangeRate} />

                  {/* MOVED BLOCK: Swiss Net Salary (Pre-Italian Tax) */}
                  {itResident.swissNetIncomeMonthlyCHF && (
                    <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 mt-2 relative overflow-hidden">
                       <div className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase mb-1 relative z-10">
                          {t('results.swissPayslipNet')}
                       </div>
                       <div className="text-xl font-bold text-slate-700 dark:text-slate-200 relative z-10">
                          <CurrencyValue value={itResident.swissNetIncomeMonthlyCHF} currency="CHF" />
                       </div>
                       <ul className="mt-3 space-y-1.5 relative z-10">
                          {itResident.details.regime === "calc.regime.newFrontier" ? (
                              <>
                                <li className="text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div> {t('results.concurrentTax')}</li>
                                {itResident.details.franchigiaEUR ? (
                                  <li className="text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> {t('results.franchiseApplied', { amount: formatCurrency(itResident.details.franchigiaEUR) })}</li>
                                ) : null}
                              </>
                          ) : (
                              <li className="text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> {t('results.exclusiveSwissTax')}</li>
                          )}
                       </ul>
                    </div>
                  )}

                  {itResident.details.notes.length > 0 && (
                    <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                        <p className="text-xs font-bold uppercase text-slate-500 dark:text-slate-400 mb-1">{t('results.notes')}</p>
                        <ul className="text-xs text-slate-500 dark:text-slate-400 list-disc list-inside">
                            {itResident.details.notes.map((note, i) => <li key={i}>{t(note.split('|')[0])}</li>)}
                        </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {!isFocusMode && (
        <>
        {/* WHY CHOOSE ONE OR THE OTHER? */}
        <div className="mb-8">
           <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
              <Heart size={14} className="text-rose-500" /> {t('results.whyConvenient')}
           </h3>
           
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Pros Svizzera */}
              <div className="bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/10 dark:to-slate-900 p-4 sm:p-6 rounded-3xl border border-blue-100 dark:border-blue-800 shadow-sm">
                 <h4 className="flex items-center gap-2 text-blue-700 dark:text-blue-400 font-bold mb-4">
                    <ShieldCheck size={18} className="text-blue-500" /> {t('results.chooseSwissIf')}
                 </h4>
                 <ul className="space-y-3 text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>{t('results.ch.quality.title')}</b> {t('results.ch.quality')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>{t('results.ch.career.title')}</b> {t('results.ch.career')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>{t('results.ch.time.title')}</b> {t('results.ch.time')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>{t('results.ch.purchasing.title')}</b> {t('results.ch.purchasing')}</span></li>
                 </ul>
              </div>

              {/* Pros Italia */}
              <div className="bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-900/10 dark:to-slate-900 p-4 sm:p-6 rounded-3xl border border-emerald-100 dark:border-emerald-800 shadow-sm">
                 <h4 className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-bold mb-4">
                    <ShoppingBag size={18} className="text-emerald-500" /> {t('results.chooseItalyIf')}
                 </h4>
                 <ul className="space-y-3 text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>{t('results.it.cost.title')}</b> {t('results.it.cost')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>{t('results.it.property.title')}</b> {t('results.it.property')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>{t('results.it.social.title')}</b> {t('results.it.social')}</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>{t('results.it.tax.title')}</b> {t('results.it.tax')}</span></li>
                 </ul>
              </div>
           </div>
           
           {/* Critical Warning */}
           <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl flex gap-3">
              <AlertCircle size={20} className="text-amber-500 shrink-0" />
              <div className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed font-medium">
                 <b>{t('results.notaBene')}</b> {t('results.disclaimer.housing')}
              </div>
           </div>
        </div>
        </>
        )}

        <div className="mb-8">
           <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Calculator size={14} className="text-indigo-500" /> {t('results.monthlyReservesChart')}
           </h3>
           <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />}>
             <ComparisonChart result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} />
           </Suspense>
        </div>

        {/* Shareable result card */}
        <Suspense fallback={null}>
          <ShareableResultCard
            title={t('results.shareTitle') || 'Simulazione Stipendio Netto'}
            subtitle={`${inputs.annualIncomeCHF?.toLocaleString('it-IT') || '0'} CHF/anno`}
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
                Analytics.trackFunnelStep('compare', { source: 'results_cta' });
                nav.navigateTo('calculator', 'whatif');
              }}
              className="w-full text-left rounded-2xl border border-teal-200 dark:border-teal-700 bg-gradient-to-br from-teal-50 via-white to-emerald-50 dark:from-teal-950/60 dark:via-slate-900 dark:to-emerald-950/40 p-5 sm:p-6 shadow-sm hover:shadow-md hover:border-teal-300 dark:hover:border-teal-600 transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
            >
              <div className="flex items-start gap-4">
                <div className="shrink-0 w-10 h-10 rounded-xl bg-teal-100 dark:bg-teal-900/60 flex items-center justify-center text-teal-600 dark:text-teal-400 group-hover:bg-teal-200 dark:group-hover:bg-teal-800/70 transition-colors">
                  <Sliders size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-teal-800 dark:text-teal-300 mb-1">
                    {t('results.compareCta.title')}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {t('results.compareCta.subtitle')}
                  </p>
                  <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 dark:text-teal-400 group-hover:gap-2.5 transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150">
                    {t('results.compareCta.button')} <ArrowRight size={14} />
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-600 dark:text-slate-400 border-t border-indigo-100 dark:border-indigo-900/40 pt-2.5">
                {t('results.compareCta.hint')}
              </p>
            </button>
          </div>
        )}

        {/* Source methodology — AI SEO citability */}
        <div className="mt-6 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            <strong>{t('results.methodology.title')}</strong>{' '}
            {t('results.methodology.description')}
          </p>
        </div>

        {/* Post-calculation newsletter CTA */}
        <Suspense fallback={null}>
          <SubscriptionCTA />
        </Suspense>

        {/* SEO: Internal cross-links to related tools */}
        <Suspense fallback={null}>
          <RelatedTools context="salary" />
        </Suspense>
      </div>
    </div>
  );
};

export const ResultsView = React.memo(ResultsViewBase);
