import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { FileText, CheckCircle2, AlertCircle, Calendar, Euro, Building2, ArrowRight, Download, Info, Clock } from 'lucide-react';
import { getHashSection, pushRoute } from '@/services/router';

const SwissTaxReturn = lazy(() => import('@/components/fisco/SwissTaxReturn'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

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
              ? 'bg-gradient-to-br from-emerald-600 to-green-700 text-white shadow-lg shadow-emerald-200 dark:shadow-emerald-900/40 ring-2 ring-emerald-400 dark:ring-emerald-500 scale-[1.02]'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-emerald-50 dark:hover:bg-slate-700 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700'
          }`}
          aria-label={t('taxReturn.countryTab.italia')}
        >
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">🇮🇹</span>
            <div>
              <h3 className={`text-lg font-bold ${countryTab === 'italia' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}`}>
                {t('taxReturn.countryTab.italia')}
              </h3>
              <p className={`text-xs ${countryTab === 'italia' ? 'text-emerald-100' : 'text-slate-500 dark:text-slate-400'}`}>
                {t('taxReturn.countryTab.italiaDesc')}
              </p>
            </div>
          </div>
          {countryTab === 'italia' && (
            <div className="flex items-center gap-1.5 mt-1">
              <CheckCircle2 size={14} className="text-emerald-200" />
              <span className="text-xs font-semibold text-emerald-100">{t('taxReturn.selected')}</span>
            </div>
          )}
        </button>
        <button
          onClick={() => handleCountryChange('svizzera')}
          className={`relative overflow-hidden rounded-2xl p-5 text-left transition-[color,background-color,border-color,box-shadow,transform] duration-300 ${
            countryTab === 'svizzera'
              ? 'bg-gradient-to-br from-red-600 to-red-700 text-white shadow-lg shadow-red-200 dark:shadow-red-900/40 ring-2 ring-red-400 dark:ring-red-500 scale-[1.02]'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-slate-700 border-2 border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-700'
          }`}
          aria-label={t('taxReturn.countryTab.svizzera')}
        >
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">🇨🇭</span>
            <div>
              <h3 className={`text-lg font-bold ${countryTab === 'svizzera' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}`}>
                {t('taxReturn.countryTab.svizzera')}
              </h3>
              <p className={`text-xs ${countryTab === 'svizzera' ? 'text-red-100' : 'text-slate-500 dark:text-slate-400'}`}>
                {t('taxReturn.countryTab.svizzeraDesc')}
              </p>
            </div>
          </div>
          {countryTab === 'svizzera' && (
            <div className="flex items-center gap-1.5 mt-1">
              <CheckCircle2 size={14} className="text-red-200" />
              <span className="text-xs font-semibold text-red-100">{t('taxReturn.selected')}</span>
            </div>
          )}
        </button>
      </div>

      {/* Country-specific header banner */}
      {countryTab === 'italia' ? (
        <div className="bg-gradient-to-r from-emerald-600 to-green-700 rounded-2xl p-4 sm:p-6 text-white">
          <div className="flex items-center gap-3 mb-2">
            <FileText size={28} />
            <h2 className="text-2xl font-bold">{t('taxReturn.title.italia')}</h2>
          </div>
          <p className="text-emerald-100 text-sm">{t('taxReturn.subtitle.italia')}</p>
        </div>
      ) : (
        <div className="bg-gradient-to-r from-red-600 to-red-700 rounded-2xl p-4 sm:p-6 text-white">
          <div className="flex items-center gap-3 mb-2">
            <FileText size={28} />
            <h2 className="text-2xl font-bold">{t('taxReturn.title.svizzera')}</h2>
          </div>
          <p className="text-red-100 text-sm">{t('taxReturn.subtitle.svizzera')}</p>
        </div>
      )}

      {countryTab === 'svizzera' ? (
        <Suspense fallback={<div className="animate-pulse bg-slate-200 dark:bg-slate-700 rounded-2xl h-96" />}>
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
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-300 dark:ring-blue-700'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
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
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4">{t('taxReturn.overview.title')}</h3>
            <div className="space-y-4 text-sm text-slate-600 dark:text-slate-400">
              <p>{t('taxReturn.overview.intro')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                  <h4 className="font-bold text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-2">
                    <Building2 size={16} /> {t('taxReturn.overview.newAgreement')}
                  </h4>
                  <p className="text-blue-600 dark:text-blue-400">{t('taxReturn.overview.newAgreementDesc')}</p>
                </div>
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                  <h4 className="font-bold text-amber-700 dark:text-amber-300 mb-2 flex items-center gap-2">
                    <AlertCircle size={16} /> {t('taxReturn.overview.oldAgreement')}
                  </h4>
                  <p className="text-amber-700 dark:text-amber-400">{t('taxReturn.overview.oldAgreementDesc')}</p>
                </div>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <h4 className="font-bold text-emerald-700 dark:text-emerald-300 mb-2">{t('taxReturn.overview.whoMustFile')}</h4>
                <ul className="list-disc list-inside space-y-1 text-emerald-700 dark:text-emerald-400">
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
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">{t('taxReturn.documents.title')}</h3>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {checkedDocs.size}/{DOCUMENTS_CHECKLIST.length} {t('taxReturn.documents.completed')}
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 mb-6">
              <div
                className="bg-emerald-700 h-2 rounded-full transition-[width] duration-300"
                style={{ width: `${(checkedDocs.size / DOCUMENTS_CHECKLIST.length) * 100}%` }}
              />
            </div>
            <div className="space-y-3">
              {DOCUMENTS_CHECKLIST.map(doc => (
                <label
                  key={doc.key}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                    checkedDocs.has(doc.key)
                      ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700'
                      : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checkedDocs.has(doc.key)}
                    onChange={() => toggleDoc(doc.key)}
                    className="mt-0.5 w-4 h-4 text-emerald-700 rounded border-slate-300 dark:border-slate-600 focus:ring-emerald-500"
                    aria-label={t(`taxReturn.documents.${doc.key}`)}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                        {t(`taxReturn.documents.${doc.key}`)}
                      </span>
                      {doc.required && (
                        <span className="text-xs font-bold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded-full">
                          {t('taxReturn.documents.required')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
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
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4">{t('taxReturn.deductions.title')}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{t('taxReturn.deductions.intro')}</p>
            <div className="space-y-3">
              {DEDUCTIONS.map(ded => (
                <div
                  key={ded.key}
                  className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-slate-200 dark:border-slate-600"
                >
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                      {t(`taxReturn.deductions.${ded.key}`)}
                    </h4>
                    {ded.maxCHF && (
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">
                        max CHF {ded.maxCHF.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
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
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-6">{t('taxReturn.timeline.title')}</h3>
            <div className="relative">
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-600" />
              <div className="space-y-6">
                {TIMELINE_2026.map((event, i) => {
                  const eventDate = new Date(event.date);
                  const isPast = eventDate < new Date();
                  return (
                    <div key={event.key} className="relative flex items-start gap-4 ml-1">
                      <div className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                        isPast
                          ? 'bg-emerald-700 text-white'
                          : 'bg-white dark:bg-slate-700 border-2 border-blue-500 text-blue-500'
                      }`}>
                        {isPast ? <CheckCircle2 size={14} /> : <Clock size={14} />}
                      </div>
                      <div className="pb-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-bold ${isPast ? 'text-emerald-700 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}`}>
                            {eventDate.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })}
                          </span>
                          {isPast && (
                            <span className="text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-bold">
                              {t('taxReturn.timeline.completed')}
                            </span>
                          )}
                        </div>
                        <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                          {t(`taxReturn.timeline.${event.key}`)}
                        </h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
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
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">{q}</span>
        <ArrowRight size={16} className={`text-slate-500 dark:text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-slate-600 dark:text-slate-400 animate-fade-in">
          {a}
        </div>
      )}
    </div>
  );
};

export default TaxReturnGuide;
