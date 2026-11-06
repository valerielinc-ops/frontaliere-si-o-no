import React, { useState, useMemo, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { Coins, Info, Calculator, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { lazyRetry } from '@/services/lazyRetry';

const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));

// Accordo 2020 art. 9: ciascun Cantone (GR, TI, VS) versa all'Italia il 40% dell'imposta
// lorda dei frontalieri dell'art. 9, fino all'anno fiscale 2033. Le somme effettivamente
// versate non sono verificate: qui non si mostra alcun importo annuo o per comune.
const COMPENSATION_RATE_ART9 = 0.4;

const RistorniTracker: React.FC = () => {
 const { t } = useTranslation();
 const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(6000);
 const [expandedSection, setExpandedSection] = useState<string | null>('calculator');

 // Estimate personal ristorni contribution
 const estimate = useMemo(() => {
 const annualGross = grossMonthlyCHF * 12;
 // Approximate Swiss withholding (7% average for a typical frontaliere)
 const estimatedSwissTax = annualGross * 0.07;
 const ristorniContribution = estimatedSwissTax * COMPENSATION_RATE_ART9;
 return {
 annualSwissTax: Math.round(estimatedSwissTax),
 ristorniToItaly: Math.round(ristorniContribution),
 monthlyEquivalent: Math.round(ristorniContribution / 12),
 };
 }, [grossMonthlyCHF]);

 const toggleSection = (key: string) => {
 setExpandedSection(expandedSection === key ? null : key);
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-r from-info-strong to-success-strong rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <Coins size={28} />
 <h2 className="text-2xl font-bold font-display">{t('ristorni.title')}</h2>
 </div>
 <p className="text-on-accent/80 text-sm">{t('ristorni.subtitle')}</p>
 </div>

 {/* What are ristorni */}
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <h3 className="font-bold text-strong mb-3 flex items-center gap-2">
 <Info size={18} className="text-info" /> {t('ristorni.whatAre')}
 </h3>
 <p className="text-sm text-subtle mb-4">{t('ristorni.explanation')}</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
 <div className="bg-neutral-subtle rounded-xl p-3 border border-neutral-border">
 <h4 className="font-bold text-sm text-neutral mb-1">{t('ristorni.oldAgreement')}</h4>
 <p className="text-sm text-neutral">{t('ristorni.oldAgreementDesc')}</p>
 </div>
 <div className="bg-warning-subtle rounded-xl p-3">
 <h4 className="font-bold text-sm text-warning mb-1">{t('ristorni.newAgreement')}</h4>
 <p className="text-sm text-warning">{t('ristorni.newAgreementDesc')}</p>
 </div>
 </div>
 </div>

 {/* Personal calculator */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('calculator')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'calculator'}>
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Calculator size={18} className="text-info" /> {t('ristorni.yourContribution')}
 </h3>
 {expandedSection === 'calculator' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {expandedSection === 'calculator' && (
 <div className="px-4 pb-4 space-y-4 border-t border-edge pt-4 animate-fade-in">
 <div className="grid grid-cols-1 gap-4">
 <div>
 <label htmlFor="ristorni-salary" className="block text-xs font-semibold text-subtle mb-1">
 {t('ristorni.monthlySalary')} (CHF)
 </label>
 <input
 id="ristorni-salary"
 type="number"
 inputMode="numeric"
 value={grossMonthlyCHF}
 onChange={e => setGrossMonthlyCHF(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
 <div className="bg-accent-subtle rounded-xl p-3 text-center">
 <p className="text-xs text-link font-semibold">{t('ristorni.annualSwissTax')}</p>
 <p className="text-lg font-bold text-accent">CHF {estimate.annualSwissTax.toLocaleString()}</p>
 </div>
 <div className="bg-info-subtle rounded-xl p-3 text-center">
 <p className="text-xs text-info font-semibold">{t('ristorni.ristorniToMunicipality')}</p>
 <p className="text-lg font-bold text-info">CHF {estimate.ristorniToItaly.toLocaleString()}</p>
 </div>
 <div className="bg-success-subtle rounded-xl p-3 text-center">
 <p className="text-sm text-success font-semibold">{t('ristorni.monthlyEquivalent')}</p>
 <p className="text-lg font-bold text-success">CHF {estimate.monthlyEquivalent.toLocaleString()}/{t('ristorni.month')}</p>
 </div>
 </div>
 <div className="bg-warning-subtle rounded-xl p-3 text-xs text-warning flex items-start gap-2">
 <AlertCircle size={14} className="shrink-0 mt-0.5" />
 <p>{t('ristorni.disclaimer')}</p>
 </div>
 </div>
 )}
 </div>

 <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
 </div>
 );
};

export default RistorniTracker;
