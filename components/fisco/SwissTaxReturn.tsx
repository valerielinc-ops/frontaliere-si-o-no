import React, { useState } from 'react';
import { useTranslation } from '@/services/i18n';
import { FileText, CheckCircle2, Calendar, Euro, Building2, ArrowRight, Info, Clock, AlertTriangle, Scale, Calculator, ExternalLink, Lightbulb, TrendingDown, FileCheck, Users, Shield, BadgeCheck } from 'lucide-react';
import { getHashSection } from '@/services/router';

type SwissTaxStep = 'overview' | 'quellensteuer' | 'correction' | 'tdr' | 'deductions' | 'documents' | 'deadlines' | 'faq';

const SWISS_TAX_STEPS = ['overview', 'quellensteuer', 'correction', 'tdr', 'deductions', 'documents', 'deadlines', 'faq'] as const;

const SWISS_DEDUCTIONS = [
  { key: 'pillar3a', maxCHF: 7258, category: 'pension' },
  { key: 'lppBuyback', maxCHF: null, category: 'pension' },
  { key: 'commuting', maxCHF: 3200, category: 'work' },
  { key: 'meals', maxCHF: 3200, category: 'work' },
  { key: 'professionalExpenses', maxCHF: 4000, category: 'work' },
  { key: 'training', maxCHF: 12000, category: 'work' },
  { key: 'healthInsurance', maxCHF: null, category: 'personal' },
  { key: 'childcare', maxCHF: 25000, category: 'family' },
  { key: 'alimony', maxCHF: null, category: 'family' },
  { key: 'donations', maxCHF: null, category: 'personal' },
  { key: 'medicalExpenses', maxCHF: null, category: 'personal' },
  { key: 'interestOnDebts', maxCHF: null, category: 'personal' },
  { key: 'lifeInsurance', maxCHF: null, category: 'personal' },
  { key: 'doubleHousehold', maxCHF: null, category: 'work' },
  { key: 'socialContributions', maxCHF: null, category: 'pension' },
] as const;

const SWISS_DEADLINES = [
  { date: '2026-01-31', key: 'lohnausweis' },
  { date: '2026-03-31', key: 'correction' },
  { date: '2026-03-31', key: 'quasiResident' },
  { date: '2026-04-30', key: 'prorogaRequest' },
  { date: '2026-06-30', key: 'tdrRequest' },
  { date: '2026-09-30', key: 'tdrFiling' },
  { date: '2026-12-31', key: 'pillar3a' },
  { date: '2026-12-31', key: 'lppBuyback' },
] as const;

const SWISS_DOCUMENTS = [
  { key: 'lohnausweis', required: true, source: 'employer' },
  { key: 'lppCertificate', required: true, source: 'employer' },
  { key: 'pillar3aReceipt', required: false, source: 'bank' },
  { key: 'healthPremiums', required: true, source: 'insurer' },
  { key: 'commutingReceipts', required: false, source: 'personal' },
  { key: 'mealReceipts', required: false, source: 'personal' },
  { key: 'trainingReceipts', required: false, source: 'personal' },
  { key: 'residenceAttestation', required: true, source: 'municipality' },
  { key: 'marriageCertificate', required: false, source: 'municipality' },
  { key: 'da1Form', required: false, source: 'taxOffice' },
  { key: 'birthCertificates', required: false, source: 'municipality' },
  { key: 'foreignTaxReturn', required: false, source: 'personal' },
  { key: 'bankStatements', required: false, source: 'bank' },
  { key: 'propertyDocs', required: false, source: 'personal' },
] as const;

const OFFICIAL_LINKS = [
  { key: 'cantonTicino', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/informazioni-sullimposte-alla-fonte' },
  { key: 'correctionForm', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/richiesta-di-correzione-dellimposizione-alla-fonte' },
  { key: 'taxTables', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte' },
  { key: 'taxCalculator', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/calcolatore-dimposta' },
  { key: 'newAgreement', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/accordo-tra-la-svizzera-e-litalia-sullimposizione-dei-lavoratori-frontalieri' },
  { key: 'etaxDownload', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/dichiarazione-elettronica' },
  { key: 'iFonte', url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/programma-ifonte' },
  { key: 'frontalierSimulator', url: 'https://www.pform2.ti.ch/form/wizard/instance-resource-id/152/instance-id/-1/form-id/124' },
] as const;

const SwissTaxReturn: React.FC = () => {
  const { t } = useTranslation();
  const [activeStep, setActiveStep] = useState<SwissTaxStep>(() => getHashSection(SWISS_TAX_STEPS, 'overview'));
  const [checkedDocs, setCheckedDocs] = useState<Set<string>>(new Set());

  const toggleDoc = (key: string) => {
    setCheckedDocs(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const steps: { key: SwissTaxStep; icon: React.ElementType; label: string }[] = [
    { key: 'overview', icon: FileText, label: t('swissTaxReturn.tabs.overview') },
    { key: 'quellensteuer', icon: Euro, label: t('swissTaxReturn.tabs.quellensteuer') },
    { key: 'correction', icon: Scale, label: t('swissTaxReturn.tabs.correction') },
    { key: 'tdr', icon: Calculator, label: t('swissTaxReturn.tabs.tdr') },
    { key: 'deductions', icon: Euro, label: t('swissTaxReturn.tabs.deductions') },
    { key: 'documents', icon: CheckCircle2, label: t('swissTaxReturn.tabs.documents') },
    { key: 'deadlines', icon: Calendar, label: t('swissTaxReturn.tabs.deadlines') },
    { key: 'faq', icon: Info, label: t('swissTaxReturn.tabs.faq') },
  ];

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-2 flex-wrap">
        {steps.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveStep(key)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
              activeStep === key
                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 ring-1 ring-red-300 dark:ring-red-700'
                : 'bg-surface text-subtle hover:bg-slate-50 dark:hover:bg-slate-700 border border-edge'
            }`}
          >
            <Icon size={16} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeStep === 'overview' && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4">{t('swissTaxReturn.overview.title')}</h3>
            <div className="space-y-4 text-sm text-subtle">
              <p>{t('swissTaxReturn.overview.intro')}</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
                  <h4 className="font-bold text-red-700 dark:text-red-300 mb-2 flex items-center gap-2">
                    <Euro size={16} /> {t('swissTaxReturn.overview.quellensteuer')}
                  </h4>
                  <p className="text-red-700 dark:text-red-400 text-xs">{t('swissTaxReturn.overview.quellensteuerDesc')}</p>
                </div>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                  <h4 className="font-bold text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-2">
                    <Scale size={16} /> {t('swissTaxReturn.overview.rettifica')}
                  </h4>
                  <p className="text-blue-700 dark:text-blue-400 text-xs">{t('swissTaxReturn.overview.rettificaDesc')}</p>
                </div>
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                  <h4 className="font-bold text-amber-700 dark:text-amber-300 mb-2 flex items-center gap-2">
                    <Calculator size={16} /> {t('swissTaxReturn.overview.tdr')}
                  </h4>
                  <p className="text-amber-700 dark:text-amber-400 text-xs">{t('swissTaxReturn.overview.tdrDesc')}</p>
                </div>
              </div>

              {/* Decision Flowchart */}
              <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-4 border border-violet-200 dark:border-violet-800">
                <h4 className="font-bold text-violet-700 dark:text-violet-300 mb-3 flex items-center gap-2">
                  <Lightbulb size={16} /> {t('swissTaxReturn.overview.flowchart')}
                </h4>
                <div className="space-y-2">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className="flex items-start gap-2 text-xs text-violet-700 dark:text-violet-400">
                      <span className="font-bold bg-violet-200 dark:bg-violet-800 rounded-full w-5 h-5 flex items-center justify-center shrink-0 text-xs">{i}</span>
                      <span>{t(`swissTaxReturn.overview.flow${i}`)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Who needs what */}
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <h4 className="font-bold text-emerald-700 dark:text-emerald-300 mb-2">{t('swissTaxReturn.overview.whoNeeds')}</h4>
                <ul className="list-disc list-inside space-y-1 text-emerald-700 dark:text-emerald-400 text-xs">
                  <li>{t('swissTaxReturn.overview.whoNeeds1')}</li>
                  <li>{t('swissTaxReturn.overview.whoNeeds2')}</li>
                  <li>{t('swissTaxReturn.overview.whoNeeds3')}</li>
                  <li>{t('swissTaxReturn.overview.whoNeeds4')}</li>
                </ul>
              </div>

              {/* Vecchi vs Nuovi Frontalieri */}
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-3">
                  <Users size={16} className="text-amber-700 dark:text-amber-400" />
                  <h4 className="font-bold text-amber-700 dark:text-amber-300">{t('swissTaxReturn.overview.oldVsNew')}</h4>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-surface rounded-lg p-3 border border-amber-300 dark:border-amber-700">
                    <h5 className="font-bold text-sm text-amber-700 dark:text-amber-300 mb-1">{t('swissTaxReturn.overview.oldFrontalier')}</h5>
                    <p className="text-sm text-amber-700 dark:text-amber-400">{t('swissTaxReturn.overview.oldFrontalierDesc')}</p>
                  </div>
                  <div className="bg-surface rounded-lg p-3 border border-amber-300 dark:border-amber-700">
                    <h5 className="font-bold text-sm text-amber-700 dark:text-amber-300 mb-1">{t('swissTaxReturn.overview.newFrontalier')}</h5>
                    <p className="text-sm text-amber-700 dark:text-amber-400">{t('swissTaxReturn.overview.newFrontalierDesc')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Official Links */}
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
              <ExternalLink size={20} /> {t('swissTaxReturn.overview.officialLinks')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {OFFICIAL_LINKS.map(link => (
                <a
                  key={link.key}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 p-3 rounded-xl border border-edge hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors group"
                >
                  <ExternalLink size={14} className="text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-semibold text-sm text-strong group-hover:text-red-700 dark:group-hover:text-red-300">{t(`swissTaxReturn.overview.link.${link.key}`)}</span>
                    <p className="text-sm text-muted mt-0.5">{t(`swissTaxReturn.overview.linkDesc.${link.key}`)}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Quellensteuer - Withholding Tax */}
      {activeStep === 'quellensteuer' && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4">{t('swissTaxReturn.quellensteuer.title')}</h3>
            <p className="text-sm text-subtle mb-4">{t('swissTaxReturn.quellensteuer.intro')}</p>
            
            <div className="space-y-4">
              {/* Tariff Tables */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-edge">
                <h4 className="font-bold text-sm text-strong mb-3">{t('swissTaxReturn.quellensteuer.tariffs')}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(['A', 'B', 'C', 'H'] as const).map(table => (
                    <div key={table} className="bg-surface rounded-lg p-3 border border-edge">
                      <span className="font-bold text-red-700 dark:text-red-400 text-sm">{t(`swissTaxReturn.quellensteuer.table${table}`)}</span>
                      <p className="text-sm text-muted mt-1">{t(`swissTaxReturn.quellensteuer.table${table}Desc`)}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* How it works */}
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                <h4 className="font-bold text-blue-700 dark:text-blue-300 text-sm mb-2">{t('swissTaxReturn.quellensteuer.howItWorks')}</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-blue-700 dark:text-blue-400">
                  <li>{t('swissTaxReturn.quellensteuer.step1')}</li>
                  <li>{t('swissTaxReturn.quellensteuer.step2')}</li>
                  <li>{t('swissTaxReturn.quellensteuer.step3')}</li>
                  <li>{t('swissTaxReturn.quellensteuer.step4')}</li>
                </ul>
              </div>

              {/* New Agreement */}
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={16} className="text-amber-700 dark:text-amber-400" />
                  <h4 className="font-bold text-amber-700 dark:text-amber-300 text-sm">{t('swissTaxReturn.quellensteuer.newAgreement')}</h4>
                </div>
                <p className="text-sm text-amber-700 dark:text-amber-400 mb-3">{t('swissTaxReturn.quellensteuer.newAgreementDesc')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="bg-surface rounded-lg p-2 border border-amber-300 dark:border-amber-700">
                    <span className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('swissTaxReturn.quellensteuer.newAgrOld')}</span>
                    <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">{t('swissTaxReturn.quellensteuer.newAgrOldDesc')}</p>
                  </div>
                  <div className="bg-surface rounded-lg p-2 border border-amber-300 dark:border-amber-700">
                    <span className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('swissTaxReturn.quellensteuer.newAgrNew')}</span>
                    <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">{t('swissTaxReturn.quellensteuer.newAgrNewDesc')}</p>
                  </div>
                </div>
              </div>

              {/* What's included in the forfait */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-edge">
                <h4 className="font-bold text-sm text-strong mb-2">{t('swissTaxReturn.quellensteuer.forfaitIncludes')}</h4>
                <ul className="list-disc list-inside space-y-1 text-xs text-subtle">
                  {[1, 2, 3, 4, 5].map(i => (
                    <li key={i}>{t(`swissTaxReturn.quellensteuer.forfait${i}`)}</li>
                  ))}
                </ul>
              </div>

              {/* Practical calculation example */}
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown size={16} className="text-emerald-700 dark:text-emerald-400" />
                  <h4 className="font-bold text-emerald-700 dark:text-emerald-300 text-sm">{t('swissTaxReturn.quellensteuer.calcExample')}</h4>
                </div>
                <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-2">{t('swissTaxReturn.quellensteuer.calcExampleIntro')}</p>
                <div className="bg-surface rounded-lg p-3 border border-emerald-300 dark:border-emerald-700 space-y-1">
                  {[1, 2, 3, 4, 5].map(i => (
                    <p key={i} className="text-sm text-emerald-700 dark:text-emerald-400 font-mono">{t(`swissTaxReturn.quellensteuer.calcLine${i}`)}</p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Correction */}
      {activeStep === 'correction' && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4">{t('swissTaxReturn.correction.title')}</h3>
            <p className="text-sm text-subtle mb-4">{t('swissTaxReturn.correction.intro')}</p>

            <div className="space-y-4">
              {/* Two request types */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                  <div className="flex items-center gap-2 mb-2">
                    <FileCheck size={16} className="text-blue-700 dark:text-blue-400" />
                    <h4 className="font-bold text-blue-700 dark:text-blue-300 text-sm">{t('swissTaxReturn.correction.request1')}</h4>
                  </div>
                  <p className="text-sm text-blue-700 dark:text-blue-400 mb-2">{t('swissTaxReturn.correction.request1Desc')}</p>
                  <ul className="list-disc list-inside space-y-1 text-sm text-blue-700 dark:text-blue-400">
                    <li>{t('swissTaxReturn.correction.request1Ex1')}</li>
                    <li>{t('swissTaxReturn.correction.request1Ex2')}</li>
                    <li>{t('swissTaxReturn.correction.request1Ex3')}</li>
                  </ul>
                </div>
                <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-4 border border-violet-200 dark:border-violet-800">
                  <div className="flex items-center gap-2 mb-2">
                    <FileCheck size={16} className="text-violet-700 dark:text-violet-400" />
                    <h4 className="font-bold text-violet-700 dark:text-violet-300 text-sm">{t('swissTaxReturn.correction.request2')}</h4>
                  </div>
                  <p className="text-xs text-violet-700 dark:text-violet-400 mb-2">{t('swissTaxReturn.correction.request2Desc')}</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-violet-700 dark:text-violet-400">
                    <li>{t('swissTaxReturn.correction.request2Ex1')}</li>
                    <li>{t('swissTaxReturn.correction.request2Ex2')}</li>
                    <li>{t('swissTaxReturn.correction.request2Ex3')}</li>
                  </ul>
                </div>
              </div>

              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <h4 className="font-bold text-emerald-700 dark:text-emerald-300 text-sm mb-2">{t('swissTaxReturn.correction.who')}</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-emerald-700 dark:text-emerald-400">
                  <li>{t('swissTaxReturn.correction.who1')}</li>
                  <li>{t('swissTaxReturn.correction.who2')}</li>
                  <li>{t('swissTaxReturn.correction.who3')}</li>
                </ul>
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                <h4 className="font-bold text-blue-700 dark:text-blue-300 text-sm mb-2">{t('swissTaxReturn.correction.how')}</h4>
                <ol className="list-decimal list-inside space-y-2 text-sm text-blue-700 dark:text-blue-400">
                  <li>{t('swissTaxReturn.correction.step1')}</li>
                  <li>{t('swissTaxReturn.correction.step2')}</li>
                  <li>{t('swissTaxReturn.correction.step3')}</li>
                  <li>{t('swissTaxReturn.correction.step4')}</li>
                </ol>
              </div>

              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-edge">
                <h4 className="font-bold text-sm text-strong mb-2">{t('swissTaxReturn.correction.deductible')}</h4>
                <ul className="list-disc list-inside space-y-1 text-xs text-subtle">
                  <li>{t('swissTaxReturn.correction.ded1')}</li>
                  <li>{t('swissTaxReturn.correction.ded2')}</li>
                  <li>{t('swissTaxReturn.correction.ded3')}</li>
                  <li>{t('swissTaxReturn.correction.ded4')}</li>
                  <li>{t('swissTaxReturn.correction.ded5')}</li>
                </ul>
              </div>

              {/* Savings example */}
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown size={16} className="text-emerald-700 dark:text-emerald-400" />
                  <h4 className="font-bold text-emerald-700 dark:text-emerald-300 text-sm">{t('swissTaxReturn.correction.savingsExample')}</h4>
                </div>
                <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-2">{t('swissTaxReturn.correction.savingsExampleDesc')}</p>
                <div className="bg-surface rounded-lg p-3 border border-emerald-300 dark:border-emerald-700 space-y-1">
                  {[1, 2, 3, 4].map(i => (
                    <p key={i} className="text-sm text-emerald-700 dark:text-emerald-400 font-mono">{t(`swissTaxReturn.correction.savingsLine${i}`)}</p>
                  ))}
                </div>
              </div>

              {/* Common mistakes */}
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={16} className="text-amber-700 dark:text-amber-400" />
                  <h4 className="font-bold text-amber-700 dark:text-amber-300 text-sm">{t('swissTaxReturn.correction.mistakes')}</h4>
                </div>
                <ul className="list-disc list-inside space-y-1 text-sm text-amber-700 dark:text-amber-400">
                  {[1, 2, 3, 4].map(i => (
                    <li key={i}>{t(`swissTaxReturn.correction.mistake${i}`)}</li>
                  ))}
                </ul>
              </div>

              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={16} className="text-red-700 dark:text-red-400" />
                  <h4 className="font-bold text-red-700 dark:text-red-300 text-sm">{t('swissTaxReturn.correction.deadline')}</h4>
                </div>
                <p className="text-xs text-red-700 dark:text-red-400">{t('swissTaxReturn.correction.deadlineDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TDR - Tassazione Ordinaria Ulteriore */}
      {activeStep === 'tdr' && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4">{t('swissTaxReturn.tdr.title')}</h3>
            <p className="text-sm text-subtle mb-4">{t('swissTaxReturn.tdr.intro')}</p>

            <div className="space-y-4">
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
                <h4 className="font-bold text-red-700 dark:text-red-300 text-sm mb-2">{t('swissTaxReturn.tdr.mandatory')}</h4>
                <ul className="list-disc list-inside space-y-1 text-xs text-red-700 dark:text-red-400">
                  <li>{t('swissTaxReturn.tdr.mandatory1')}</li>
                  <li>{t('swissTaxReturn.tdr.mandatory2')}</li>
                  <li>{t('swissTaxReturn.tdr.mandatory3')}</li>
                </ul>
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                <h4 className="font-bold text-blue-700 dark:text-blue-300 text-sm mb-2">{t('swissTaxReturn.tdr.quasiResident')}</h4>
                <p className="text-sm text-blue-700 dark:text-blue-400 mb-2">{t('swissTaxReturn.tdr.quasiResidentDesc')}</p>
                <div className="bg-surface rounded-lg p-3 border border-blue-300 dark:border-blue-700">
                  <p className="text-xs font-bold text-blue-700 dark:text-blue-300">{t('swissTaxReturn.tdr.quasiResidentRule')}</p>
                </div>
                <div className="mt-2 bg-surface rounded-lg p-3 border border-blue-300 dark:border-blue-700">
                  <p className="text-xs font-bold text-blue-700 dark:text-blue-300 mb-1">{t('swissTaxReturn.tdr.quasiResidentExample')}</p>
                  <p className="text-sm text-blue-700 dark:text-blue-400">{t('swissTaxReturn.tdr.quasiResidentExampleDesc')}</p>
                </div>
              </div>

              {/* Detailed eTax guide */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-edge">
                <h4 className="font-bold text-sm text-strong mb-2">{t('swissTaxReturn.tdr.etax')}</h4>
                <p className="text-sm text-subtle mb-3">{t('swissTaxReturn.tdr.etaxDesc')}</p>
                <ol className="list-decimal list-inside space-y-2 text-xs text-subtle">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                    <li key={i}>{t(`swissTaxReturn.tdr.etaxStep${i}`)}</li>
                  ))}
                </ol>
              </div>

              {/* Rettifica vs TDR comparison */}
              <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-4 border border-violet-200 dark:border-violet-800">
                <h4 className="font-bold text-violet-700 dark:text-violet-300 text-sm mb-3">{t('swissTaxReturn.tdr.comparison')}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-surface rounded-lg p-3 border border-violet-300 dark:border-violet-700">
                    <h5 className="font-bold text-xs text-violet-700 dark:text-violet-300 mb-2">{t('swissTaxReturn.tdr.compRettifica')}</h5>
                    <ul className="list-disc list-inside space-y-1 text-xs text-violet-700 dark:text-violet-400">
                      <li>{t('swissTaxReturn.tdr.compRettifica1')}</li>
                      <li>{t('swissTaxReturn.tdr.compRettifica2')}</li>
                      <li>{t('swissTaxReturn.tdr.compRettifica3')}</li>
                    </ul>
                  </div>
                  <div className="bg-surface rounded-lg p-3 border border-violet-300 dark:border-violet-700">
                    <h5 className="font-bold text-xs text-violet-700 dark:text-violet-300 mb-2">{t('swissTaxReturn.tdr.compTDR')}</h5>
                    <ul className="list-disc list-inside space-y-1 text-xs text-violet-700 dark:text-violet-400">
                      <li>{t('swissTaxReturn.tdr.compTDR1')}</li>
                      <li>{t('swissTaxReturn.tdr.compTDR2')}</li>
                      <li>{t('swissTaxReturn.tdr.compTDR3')}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <h4 className="font-bold text-emerald-700 dark:text-emerald-300 text-sm mb-2">{t('swissTaxReturn.tdr.advantages')}</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-emerald-700 dark:text-emerald-400">
                  <li>{t('swissTaxReturn.tdr.adv1')}</li>
                  <li>{t('swissTaxReturn.tdr.adv2')}</li>
                  <li>{t('swissTaxReturn.tdr.adv3')}</li>
                </ul>
              </div>

              {/* Risks */}
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={16} className="text-amber-700 dark:text-amber-400" />
                  <h4 className="font-bold text-amber-700 dark:text-amber-300 text-sm">{t('swissTaxReturn.tdr.risks')}</h4>
                </div>
                <ul className="list-disc list-inside space-y-1 text-sm text-amber-700 dark:text-amber-400">
                  <li>{t('swissTaxReturn.tdr.risk1')}</li>
                  <li>{t('swissTaxReturn.tdr.risk2')}</li>
                  <li>{t('swissTaxReturn.tdr.risk3')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deductions */}
      {activeStep === 'deductions' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-4">{t('swissTaxReturn.deductions.title')}</h3>
            <p className="text-sm text-muted mb-6">{t('swissTaxReturn.deductions.intro')}</p>
            <div className="space-y-3">
              {SWISS_DEDUCTIONS.map(ded => (
                <div
                  key={ded.key}
                  className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 border border-edge"
                >
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-sm text-strong">
                      {t(`swissTaxReturn.deductions.${ded.key}`)}
                    </h4>
                    {ded.maxCHF && (
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">
                        max CHF {ded.maxCHF.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted">
                    {t(`swissTaxReturn.deductions.${ded.key}Desc`)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Documents checklist */}
      {activeStep === 'documents' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-strong">{t('swissTaxReturn.documents.title')}</h3>
              <span className="text-sm text-muted">
                {checkedDocs.size}/{SWISS_DOCUMENTS.length} {t('swissTaxReturn.documents.completed')}
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 mb-6 overflow-hidden">
              <div
                className="bg-red-700 h-2 rounded-full transition-transform duration-300 origin-left"
                style={{ transform: `scaleX(${checkedDocs.size / SWISS_DOCUMENTS.length})` }}
              />
            </div>
            <div className="space-y-3">
              {SWISS_DOCUMENTS.map(doc => (
                <label
                  key={doc.key}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                    checkedDocs.has(doc.key)
                      ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700'
                      : 'bg-surface border-edge hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checkedDocs.has(doc.key)}
                    onChange={() => toggleDoc(doc.key)}
                    className="mt-0.5 w-4 h-4 text-red-700 rounded border-slate-300 dark:border-slate-600 focus-visible:ring-red-500"
                    aria-label={t(`swissTaxReturn.documents.${doc.key}`)}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-strong">
                        {t(`swissTaxReturn.documents.${doc.key}`)}
                      </span>
                      {doc.required && (
                        <span className="text-xs font-bold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded-full">
                          {t('swissTaxReturn.documents.required')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted mt-0.5">
                      {t(`swissTaxReturn.documents.${doc.key}Desc`)}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Deadlines */}
      {activeStep === 'deadlines' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
            <h3 className="text-lg font-bold text-strong mb-6">{t('swissTaxReturn.deadlines.title')}</h3>
            <div className="relative">
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-600" />
              <div className="space-y-6">
                {SWISS_DEADLINES.map((event) => {
                  const eventDate = new Date(event.date);
                  const isPast = eventDate < new Date();
                  return (
                    <div key={event.key} className="relative flex items-start gap-4 ml-1">
                      <div className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                        isPast
                          ? 'bg-red-700 text-white'
                          : 'bg-white dark:bg-slate-700 border-2 border-red-500 text-red-500'
                      }`}>
                        {isPast ? <CheckCircle2 size={14} /> : <Clock size={14} />}
                      </div>
                      <div className="pb-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-bold ${isPast ? 'text-red-700 dark:text-red-400' : 'text-red-600 dark:text-red-400'}`}>
                            {eventDate.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })}
                          </span>
                          {isPast && (
                            <span className="text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-bold">
                              {t('swissTaxReturn.deadlines.completed')}
                            </span>
                          )}
                        </div>
                        <h4 className="font-semibold text-sm text-strong">
                          {t(`swissTaxReturn.deadlines.${event.key}`)}
                        </h4>
                        <p className="text-sm text-muted mt-0.5">
                          {t(`swissTaxReturn.deadlines.${event.key}Desc`)}
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
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => (
            <FaqItem key={i} q={t(`swissTaxReturn.faq.q${i}`)} a={t(`swissTaxReturn.faq.a${i}`)} />
          ))}
        </div>
      )}
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

export default SwissTaxReturn;
