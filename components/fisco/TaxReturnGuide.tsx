import React, { useState, useEffect, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { FileText, CheckCircle2, AlertCircle, Calendar, Euro, Building2, ArrowRight, Download, Info, Clock } from 'lucide-react';
import { getHashSection, pushRoute } from '@/services/router';
import { lazyRetry } from '@/services/lazyRetry';

const SwissTaxReturn = lazyRetry(() => import('@/components/fisco/SwissTaxReturn'));
const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));

type CountryTab = 'italia' | 'svizzera';
type TaxStep = 'overview' | 'documents' | 'deductions' | 'timeline' | 'faq';

const TAX_STEPS = ['overview', 'documents', 'deductions', 'timeline', 'faq'] as const;

const DEDUCTIONS = [
 { key: 'commuting', maxCHF: 3200, maxEUR: 3200, category: 'work' },
 { key: 'meals', maxCHF: 3200, maxEUR: null, category: 'work' },
 { key: 'lpp', maxCHF: null, maxEUR: null, category: 'pension' },
 { key: 'pillar3a', maxCHF: 7258, maxEUR: null, category: 'pension' },
 { key: 'healthInsurance', maxCHF: null, maxEUR: null, category: 'personal' },
 { key: 'childcare', maxCHF: 25000, maxEUR: null, category: 'family' },
 { key: 'alimony', maxCHF: null, maxEUR: null, category: 'family' },
 { key: 'donations', maxCHF: null, maxEUR: null, category: 'personal' },
] as const;

const TIMELINE_2026 = [
 { date: '2026-01-31', key: 'certificatoStipendio' },
 { date: '2026-03-31', key: 'cuPrecompilato' },
 { date: '2026-04-30', key: 'precompilataOnline' },
 { date: '2026-06-30', key: 'invio730' },
 { date: '2026-09-30', key: 'invioRedditiPF' },
 { date: '2026-11-30', key: 'accontoIrpef' },
] as const;

const DOCUMENTS_CHECKLIST = [
 { key: 'lohnausweis', required: true, source: 'employer' },
 { key: 'attestatoLPP', required: true, source: 'employer' },
 { key: 'attestatoPillar3', required: false, source: 'bank' },
 { key: 'ricevuteSpeseMediche', required: false, source: 'personal' },
 { key: 'abbonamentoTrasporti', required: false, source: 'personal' },
 { key: 'attestatoAssicurazioneSanitaria', required: true, source: 'insurer' },
 { key: 'ricevuteDonazioni', required: false, source: 'personal' },
 { key: 'certificatoInteressiMutuo', required: false, source: 'bank' },
 { key: 'certificatoFigli', required: false, source: 'municipality' },
 { key: 'CU', required: true, source: 'employer' },
] as const;

interface TaxReturnGuideProps {
 initialCountry?: 'italia' | 'svizzera';
 onCountryChange?: (country: 'italia' | 'svizzera') => void;
}

const TaxReturnGuide: React.FC<TaxReturnGuideProps> = ({ initialCountry, onCountryChange }) => {
 const { t } = useTranslation();
 const [countryTab, setCountryTab] = useState<CountryTab>(initialCountry || 'italia');
 const [activeStep, setActiveStep] = useState<TaxStep>(() => getHashSection(TAX_STEPS, 'overview'));
 const [checkedDocs, setCheckedDocs] = useState<Set<string>>(new Set());

 // Sync with URL-driven country prop
 useEffect(() => {
 if (initialCountry && initialCountry !== countryTab) {
 setCountryTab(initialCountry);
 }
 }, [initialCountry]);

 const handleCountryChange = (country: CountryTab) => {
 setCountryTab(country);
 onCountryChange?.(country);
 pushRoute({ activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: country });
 };

 const toggleDoc = (key: string) => {
 setCheckedDocs(prev => {
 const next = new Set(prev);
 if (next.has(key)) next.delete(key);
 else next.add(key);
 return next;
 });
 };

 const steps: { key: TaxStep; icon: React.ElementType; label: string }[] = [
 { key: 'overview', icon: FileText, label: t('taxReturn.tabs.overview') },
 { key: 'documents', icon: CheckCircle2, label: t('taxReturn.tabs.documents') },
 { key: 'deductions', icon: Euro, label: t('taxReturn.tabs.deductions') },
 { key: 'timeline', icon: Calendar, label: t('taxReturn.tabs.timeline') },
 { key: 'faq', icon: Info, label: t('taxReturn.tabs.faq') },
 ];

 return (
 <div className="space-y-6">
 {/* Full-width country selector */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <button
 onClick={() => handleCountryChange('italia')}
 className={`relative overflow-hidden rounded-2xl p-5 text-left transition-[color,background-color,border-color,box-shadow,transform] duration-300 ${
 countryTab === 'italia'
 ? 'bg-gradient-to-br from-success to-success text-on-accent shadow-lg shadow-success-border ring-2 ring-success-border scale-[1.02]'
 : 'bg-surface text-subtle hover:bg-success-subtle border-2 border-edge hover:border-success-border'
 }`}
 aria-label={t('taxReturn.countryTab.italia')}
 >
 <div className="flex items-center gap-3 mb-2">
 <span className="text-3xl">🇮🇹</span>
 <div>
 <h3 className={`text-lg font-bold font-display ${countryTab === 'italia' ? 'text-on-accent' : 'text-strong'}`}>
 {t('taxReturn.countryTab.italia')}
 </h3>
 <p className={`text-xs ${countryTab === 'italia' ? 'text-on-accent/70' : 'text-muted'}`}>
 {t('taxReturn.countryTab.italiaDesc')}
 </p>
 </div>
 </div>
 {countryTab === 'italia' && (
 <div className="flex items-center gap-1.5 mt-1">
 <CheckCircle2 size={14} className="text-on-accent/70" />
 <span className="text-xs font-semibold text-on-accent/70">{t('taxReturn.selected')}</span>
 </div>
 )}
 </button>
 <button
 onClick={() => handleCountryChange('svizzera')}
 className={`relative overflow-hidden rounded-2xl p-5 text-left transition-[color,background-color,border-color,box-shadow,transform] duration-300 ${
 countryTab === 'svizzera'
 ? 'bg-gradient-to-br from-danger to-danger text-on-accent shadow-lg shadow-danger-border ring-2 ring-danger-border scale-[1.02]'
 : 'bg-surface text-subtle hover:bg-danger-subtle border-2 border-edge hover:border-danger-border'
 }`}
 aria-label={t('taxReturn.countryTab.svizzera')}
 >
 <div className="flex items-center gap-3 mb-2">
 <span className="text-3xl">🇨🇭</span>
 <div>
 <h3 className={`text-lg font-bold font-display ${countryTab === 'svizzera' ? 'text-on-accent' : 'text-strong'}`}>
 {t('taxReturn.countryTab.svizzera')}
 </h3>
 <p className={`text-xs ${countryTab === 'svizzera' ? 'text-on-accent/70' : 'text-muted'}`}>
 {t('taxReturn.countryTab.svizzeraDesc')}
 </p>
 </div>
 </div>
 {countryTab === 'svizzera' && (
 <div className="flex items-center gap-1.5 mt-1">
 <CheckCircle2 size={14} className="text-on-accent/70" />
 <span className="text-xs font-semibold text-on-accent/70">{t('taxReturn.selected')}</span>
 </div>
 )}
 </button>
 </div>

 {/* Country-specific header banner */}
 {countryTab === 'italia' ? (
 <div className="bg-gradient-to-r from-success to-success rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <FileText size={28} />
 <h2 className="text-2xl font-bold font-display">{t('taxReturn.title.italia')}</h2>
 </div>
 <p className="text-on-accent/70 text-sm">{t('taxReturn.subtitle.italia')}</p>
 </div>
 ) : (
 <div className="bg-gradient-to-r from-danger to-danger rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <FileText size={28} />
 <h2 className="text-2xl font-bold font-display">{t('taxReturn.title.svizzera')}</h2>
 </div>
 <p className="text-on-accent/70 text-sm">{t('taxReturn.subtitle.svizzera')}</p>
 </div>
 )}

 {countryTab === 'svizzera' ? (
 <Suspense fallback={<div className="animate-pulse bg-surface-raised rounded-2xl h-96" />}>
 <SwissTaxReturn />
 </Suspense>
 ) : (
 <>
 {/* Tab navigation */}
 <div className="flex gap-2 flex-wrap">
 {steps.map(({ key, icon: Icon, label }) => (
 <button
 key={key}
 onClick={() => setActiveStep(key)}
 className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
 activeStep === key
 ? 'bg-accent-subtle text-accent ring-1 ring-accent'
 : 'bg-surface text-subtle hover:bg-surface-raised border border-edge'
 }`}
 >
 <Icon size={16} />
 {label}
 </button>
 ))}
 </div>

 {/* Overview */}
 {activeStep === 'overview' && (
 <div className="space-y-6 animate-fade-in">
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <h3 className="text-lg font-bold font-display text-strong mb-4">{t('taxReturn.overview.title')}</h3>
 <div className="space-y-4 text-sm text-subtle">
 <p>{t('taxReturn.overview.intro')}</p>
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 <div className="bg-neutral-subtle rounded-xl p-4 border border-neutral-border">
 <h4 className="font-bold text-neutral mb-2 flex items-center gap-2">
 <Building2 size={16} /> {t('taxReturn.overview.newAgreement')}
 </h4>
 <p className="text-neutral">{t('taxReturn.overview.newAgreementDesc')}</p>
 </div>
 <div className="bg-warning-subtle rounded-xl p-4 border border-warning-border">
 <h4 className="font-bold text-warning mb-2 flex items-center gap-2">
 <AlertCircle size={16} /> {t('taxReturn.overview.oldAgreement')}
 </h4>
 <p className="text-warning">{t('taxReturn.overview.oldAgreementDesc')}</p>
 </div>
 </div>
 <div className="bg-success-subtle rounded-xl p-4 border border-success-border">
 <h4 className="font-bold text-success mb-2">{t('taxReturn.overview.whoMustFile')}</h4>
 <ul className="list-disc list-inside space-y-1 text-success">
 <li>{t('taxReturn.overview.whoMustFile1')}</li>
 <li>{t('taxReturn.overview.whoMustFile2')}</li>
 <li>{t('taxReturn.overview.whoMustFile3')}</li>
 </ul>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* Documents checklist */}
 {activeStep === 'documents' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <div className="flex items-center justify-between mb-4">
 <h3 className="text-lg font-bold font-display text-strong">{t('taxReturn.documents.title')}</h3>
 <span className="text-sm text-muted">
 {checkedDocs.size}/{DOCUMENTS_CHECKLIST.length} {t('taxReturn.documents.completed')}
 </span>
 </div>
 <div className="w-full bg-surface-raised rounded-full h-2 mb-6 overflow-hidden">
 <div
 className="bg-success-strong h-2 rounded-full transition-transform duration-300 origin-left"
 style={{ transform: `scaleX(${checkedDocs.size / DOCUMENTS_CHECKLIST.length})` }}
 />
 </div>
 <div className="space-y-3">
 {DOCUMENTS_CHECKLIST.map(doc => (
 <label
 key={doc.key}
 className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
 checkedDocs.has(doc.key)
 ? 'bg-success-subtle border-success-border'
 : 'bg-surface border-edge hover:border-edge'
 }`}
 >
 <input
 type="checkbox"
 checked={checkedDocs.has(doc.key)}
 onChange={() => toggleDoc(doc.key)}
 className="mt-0.5 w-4 h-4 text-success rounded border-edge focus-visible:ring-success"
 aria-label={t(`taxReturn.documents.${doc.key}`)}
 />
 <div className="flex-1">
 <div className="flex items-center gap-2">
 <span className="font-semibold text-sm text-strong">
 {t(`taxReturn.documents.${doc.key}`)}
 </span>
 {doc.required && (
 <span className="text-xs font-bold bg-danger-subtle text-danger px-1.5 py-0.5 rounded-full">
 {t('taxReturn.documents.required')}
 </span>
 )}
 </div>
 <p className="text-sm text-muted mt-0.5">
 {t(`taxReturn.documents.${doc.key}Desc`)}
 </p>
 </div>
 </label>
 ))}
 </div>
 </div>
 </div>
 )}

 {/* Deductions */}
 {activeStep === 'deductions' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <h3 className="text-lg font-bold font-display text-strong mb-4">{t('taxReturn.deductions.title')}</h3>
 <p className="text-sm text-muted mb-6">{t('taxReturn.deductions.intro')}</p>
 <div className="space-y-3">
 {DEDUCTIONS.map(ded => (
 <div
 key={ded.key}
 className="bg-neutral-subtle rounded-xl p-4 border border-neutral-border"
 >
 <div className="flex items-center justify-between mb-1">
 <h4 className="font-semibold text-sm text-strong">
 {t(`taxReturn.deductions.${ded.key}`)}
 </h4>
 {ded.maxCHF && (
 <span className="text-xs font-bold text-success bg-success-subtle px-2 py-0.5 rounded-full">
 max CHF {ded.maxCHF.toLocaleString()}
 </span>
 )}
 </div>
 <p className="text-sm text-muted">
 {t(`taxReturn.deductions.${ded.key}Desc`)}
 </p>
 </div>
 ))}
 </div>
 </div>
 </div>
 )}

 {/* Timeline */}
 {activeStep === 'timeline' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <h3 className="text-lg font-bold font-display text-strong mb-6">{t('taxReturn.timeline.title')}</h3>
 <div className="relative">
 <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-surface-raised" />
 <div className="space-y-6">
 {TIMELINE_2026.map((event, i) => {
 const eventDate = new Date(event.date);
 const isPast = eventDate < new Date();
 return (
 <div key={event.key} className="relative flex items-start gap-4 ml-1">
 <div className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
 isPast
 ? 'bg-success-strong text-on-accent'
 : 'bg-surface border-2 border-accent text-accent'
 }`}>
 {isPast ? <CheckCircle2 size={14} /> : <Clock size={14} />}
 </div>
 <div className="pb-2">
 <div className="flex items-center gap-2 mb-1">
 <span className={`text-xs font-bold ${isPast ? 'text-success' : 'text-link'}`}>
 {eventDate.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })}
 </span>
 {isPast && (
 <span className="text-xs bg-success-subtle text-success px-1.5 py-0.5 rounded-full font-bold">
 {t('taxReturn.timeline.completed')}
 </span>
 )}
 </div>
 <h4 className="font-semibold text-sm text-strong">
 {t(`taxReturn.timeline.${event.key}`)}
 </h4>
 <p className="text-sm text-muted mt-0.5">
 {t(`taxReturn.timeline.${event.key}Desc`)}
 </p>
 </div>
 </div>
 );
 })}
 </div>
 </div>
 </div>
 </div>
 )}

 {/* FAQ */}
 {activeStep === 'faq' && (
 <div className="space-y-4 animate-fade-in">
 <FaqItem q={t('taxReturn.faq.q1')} a={t('taxReturn.faq.a1')} />
 <FaqItem q={t('taxReturn.faq.q2')} a={t('taxReturn.faq.a2')} />
 <FaqItem q={t('taxReturn.faq.q3')} a={t('taxReturn.faq.a3')} />
 <FaqItem q={t('taxReturn.faq.q4')} a={t('taxReturn.faq.a4')} />
 <FaqItem q={t('taxReturn.faq.q5')} a={t('taxReturn.faq.a5')} />
 </div>
 )}
 </>
 )}
 <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
 </div>
 );
};

const FaqItem: React.FC<{ q: string; a: string }> = ({ q, a }) => {
 const [open, setOpen] = useState(false);
 return (
 <div className="bg-surface rounded-xl border border-edge overflow-hidden">
 <button
 onClick={() => setOpen(!open)}
 className="w-full flex items-center justify-between p-4 text-left"
 >
 <span className="font-semibold text-sm text-strong">{q}</span>
 <ArrowRight size={16} className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
 </button>
 {open && (
 <div className="px-4 pb-4 text-sm text-subtle animate-fade-in">
 {a}
 </div>
 )}
 </div>
 );
};

export default TaxReturnGuide;
