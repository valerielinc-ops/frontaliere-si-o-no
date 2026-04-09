import React, { useState } from 'react';
import { useTranslation } from '@/services/i18n';
import { Car, FileText, CreditCard, Shield, Clock, CheckCircle2, AlertCircle, Info, ChevronDown, ChevronUp, ArrowRight, Landmark, ExternalLink, MapPin } from 'lucide-react';
import { getHashSection } from '@/services/router';

type CarSection = 'overview' | 'customs' | 'registration' | 'plates' | 'license' | 'insurance' | 'costs' | 'checklist';

const CAR_SECTIONS = ['overview', 'customs', 'registration', 'plates', 'license', 'insurance', 'costs', 'checklist'] as const;

const CarTransferGuide: React.FC = () => {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<CarSection>(() => getHashSection(CAR_SECTIONS, 'overview'));
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const sections: { key: CarSection; icon: React.ElementType; label: string }[] = [
    { key: 'overview', icon: Car, label: t('carTransfer.sections.overview') },
    { key: 'customs', icon: Landmark, label: t('carTransfer.sections.customs') },
    { key: 'registration', icon: FileText, label: t('carTransfer.sections.registration') },
    { key: 'plates', icon: MapPin, label: t('carTransfer.sections.plates') },
    { key: 'license', icon: CreditCard, label: t('carTransfer.sections.license') },
    { key: 'insurance', icon: Shield, label: t('carTransfer.sections.insurance') },
    { key: 'costs', icon: CreditCard, label: t('carTransfer.sections.costs') },
    { key: 'checklist', icon: CheckCircle2, label: t('carTransfer.sections.checklist') },
  ];

  const faqItems = [
    { q: t('carTransfer.faq.q1'), a: t('carTransfer.faq.a1') },
    { q: t('carTransfer.faq.q2'), a: t('carTransfer.faq.a2') },
    { q: t('carTransfer.faq.q3'), a: t('carTransfer.faq.a3') },
    { q: t('carTransfer.faq.q4'), a: t('carTransfer.faq.a4') },
    { q: t('carTransfer.faq.q5'), a: t('carTransfer.faq.a5') },
    { q: t('carTransfer.faq.q6'), a: t('carTransfer.faq.a6') },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-2xl p-4 sm:p-6 text-white">
        <div className="flex items-center gap-3 mb-3">
          <div className="p-3 bg-white/20 rounded-xl">
            <Car size={28} />
          </div>
          <div>
            <h2 className="text-2xl font-bold">{t('carTransfer.title')}</h2>
            <p className="text-blue-100 text-sm mt-1">{t('carTransfer.subtitle')}</p>
          </div>
        </div>
        <div className="mt-4 bg-white/10 rounded-xl p-4">
          <div className="flex items-start gap-2">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm text-blue-100">{t('carTransfer.disclaimer')}</p>
          </div>
        </div>
      </div>

      {/* Section Navigation */}
      <div className="flex flex-wrap gap-2">
        {sections.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveSection(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
              activeSection === key
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
      {activeSection === 'overview' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4">{t('carTransfer.overview.title')}</h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.overview.intro')}</p>
            
            {/* Timeline */}
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">{t('carTransfer.overview.timeline')}</h4>
              {[
                { step: '1', title: t('carTransfer.overview.step1Title'), desc: t('carTransfer.overview.step1Desc'), time: t('carTransfer.overview.step1Time') },
                { step: '2', title: t('carTransfer.overview.step2Title'), desc: t('carTransfer.overview.step2Desc'), time: t('carTransfer.overview.step2Time') },
                { step: '3', title: t('carTransfer.overview.step3Title'), desc: t('carTransfer.overview.step3Desc'), time: t('carTransfer.overview.step3Time') },
                { step: '4', title: t('carTransfer.overview.step4Title'), desc: t('carTransfer.overview.step4Desc'), time: t('carTransfer.overview.step4Time') },
                { step: '5', title: t('carTransfer.overview.step5Title'), desc: t('carTransfer.overview.step5Desc'), time: t('carTransfer.overview.step5Time') },
              ].map((item, i) => (
                <div key={i} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">{item.step}</div>
                    {i < 4 && <div className="w-0.5 h-full bg-blue-200 dark:bg-blue-800 mt-1" />}
                  </div>
                  <div className="flex-1 pb-4">
                    <h5 className="font-bold text-slate-800 dark:text-slate-200">{item.title}</h5>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{item.desc}</p>
                    <div className="flex items-center gap-1 mt-2 text-xs text-blue-600 dark:text-blue-400">
                      <Clock size={12} />
                      {item.time}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Key deadlines */}
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <h4 className="font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2 mb-3">
              <AlertCircle size={18} />
              {t('carTransfer.overview.deadlinesTitle')}
            </h4>
            <ul className="space-y-2 text-sm text-amber-700 dark:text-amber-400">
              <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.overview.deadline1')}</li>
              <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.overview.deadline2')}</li>
              <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.overview.deadline3')}</li>
            </ul>
          </div>
        </div>
      )}

      {/* Customs (Dogana/UDSC) */}
      {activeSection === 'customs' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <Landmark size={20} className="text-blue-600" />
              {t('carTransfer.customs.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.customs.intro')}</p>

            <div className="space-y-4">
              <div className="bg-warm-50 dark:bg-warm-950 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-2">{t('carTransfer.customs.formTitle')}</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">{t('carTransfer.customs.formDesc')}</p>
                <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.customs.doc1')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.customs.doc2')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.customs.doc3')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.customs.doc4')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.customs.doc5')}</li>
                </ul>
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4">
                <h4 className="font-bold text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-2">
                  <Info size={16} />
                  {t('carTransfer.customs.taxTitle')}
                </h4>
                <p className="text-sm text-blue-600 dark:text-blue-400 mb-3">{t('carTransfer.customs.taxDesc')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                    <div className="text-xs text-blue-600 dark:text-blue-400 font-semibold">{t('carTransfer.customs.ivaLabel')}</div>
                    <div className="text-xl font-bold text-slate-800 dark:text-slate-200">8.1%</div>
                    <div className="text-sm text-slate-500 dark:text-slate-400">{t('carTransfer.customs.ivaNote')}</div>
                  </div>
                  <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                    <div className="text-xs text-blue-600 dark:text-blue-400 font-semibold">{t('carTransfer.customs.dutyLabel')}</div>
                    <div className="text-xl font-bold text-slate-800 dark:text-slate-200">0 CHF</div>
                    <div className="text-sm text-slate-500 dark:text-slate-400">{t('carTransfer.customs.dutyNote')}</div>
                  </div>
                </div>
              </div>

              <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4">
                <h4 className="font-bold text-green-700 dark:text-green-300 mb-2 flex items-center gap-2">
                  <CheckCircle2 size={16} />
                  {t('carTransfer.customs.exemptionTitle')}
                </h4>
                <p className="text-sm text-green-600 dark:text-green-400">{t('carTransfer.customs.exemptionDesc')}</p>
                <ul className="space-y-1 mt-2 text-sm text-green-600 dark:text-green-400">
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.customs.exemption1')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.customs.exemption2')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="mt-1 shrink-0" />{t('carTransfer.customs.exemption3')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Registration (Immatricolazione) */}
      {activeSection === 'registration' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <FileText size={20} className="text-blue-600" />
              {t('carTransfer.registration.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.registration.intro')}</p>

            <div className="space-y-4">
              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.registration.mfkTitle')}</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">{t('carTransfer.registration.mfkDesc')}</p>
                <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.registration.mfk1')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.registration.mfk2')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.registration.mfk3')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.registration.mfk4')}</li>
                </ul>
              </div>

              <div className="bg-warm-50 dark:bg-warm-950 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.registration.docsTitle')}</h4>
                <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc1')}</li>
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc2')}</li>
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc3')}</li>
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc4')}</li>
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc5')}</li>
                  <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-blue-600" />{t('carTransfer.registration.doc6')}</li>
                </ul>
              </div>

              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
                <h4 className="font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  {t('carTransfer.registration.tiTitle')}
                </h4>
                <p className="text-sm text-amber-700 dark:text-amber-400">{t('carTransfer.registration.tiDesc')}</p>
                <a
                  href="https://www4.ti.ch/di/sc/veicoli/immatricolazione"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-sm text-amber-700 dark:text-amber-400 underline hover:text-amber-900 dark:hover:text-amber-200"
                >
                  {t('carTransfer.registration.tiLink')}
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Swiss Plates */}
      {activeSection === 'plates' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <MapPin size={20} className="text-blue-600" />
              {t('carTransfer.plates.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.plates.intro')}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.plates.typesTitle')}</h4>
                <ul className="space-y-3 text-sm">
                  <li className="flex items-start gap-3">
                    <div className="shrink-0 w-16 h-8 bg-white dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-600 rounded flex items-center justify-center text-xs font-bold text-slate-700 dark:text-slate-300">TI ···</div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300">{t('carTransfer.plates.permanent')}</div>
                      <div className="text-slate-500 dark:text-slate-400">{t('carTransfer.plates.permanentDesc')}</div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="shrink-0 w-16 h-8 bg-blue-100 border-2 border-blue-300 rounded flex items-center justify-center text-xs font-bold text-blue-700">U ···</div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300">{t('carTransfer.plates.temp')}</div>
                      <div className="text-slate-500 dark:text-slate-400">{t('carTransfer.plates.tempDesc')}</div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="shrink-0 w-16 h-8 bg-yellow-100 border-2 border-yellow-400 rounded flex items-center justify-center text-xs font-bold text-yellow-700">TI ···</div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300">{t('carTransfer.plates.transfer')}</div>
                      <div className="text-slate-500 dark:text-slate-400">{t('carTransfer.plates.transferDesc')}</div>
                    </div>
                  </li>
                </ul>
              </div>

              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.plates.costTitle')}</h4>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between items-center py-2 border-b border-slate-200 dark:border-slate-700">
                    <span className="text-slate-600 dark:text-slate-400">{t('carTransfer.plates.costPlate')}</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">CHF 30–50</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-200 dark:border-slate-700">
                    <span className="text-slate-600 dark:text-slate-400">{t('carTransfer.plates.costLicenseDoc')}</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">CHF 50–80</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-200 dark:border-slate-700">
                    <span className="text-slate-600 dark:text-slate-400">{t('carTransfer.plates.costVignette')}</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">CHF 40</span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-slate-600 dark:text-slate-400">{t('carTransfer.plates.costTax')}</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">{t('carTransfer.plates.costTaxVal')}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4">
              <div className="flex items-start gap-2">
                <Info size={16} className="mt-0.5 shrink-0 text-blue-600" />
                <p className="text-sm text-blue-700 dark:text-blue-400">{t('carTransfer.plates.italianNote')}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Driving License Exchange */}
      {activeSection === 'license' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <CreditCard size={20} className="text-blue-600" />
              {t('carTransfer.license.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.license.intro')}</p>

            <div className="space-y-4">
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
                <h4 className="font-bold text-red-700 dark:text-red-300 flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  {t('carTransfer.license.deadlineTitle')}
                </h4>
                <p className="text-sm text-red-600 dark:text-red-400">{t('carTransfer.license.deadlineDesc')}</p>
              </div>

              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.license.processTitle')}</h4>
                <ol className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
                  <li className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">1</span>
                    <span>{t('carTransfer.license.step1')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
                    <span>{t('carTransfer.license.step2')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
                    <span>{t('carTransfer.license.step3')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">4</span>
                    <span>{t('carTransfer.license.step4')}</span>
                  </li>
                </ol>
              </div>

              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.license.docsTitle')}</h4>
                <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.license.doc1')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.license.doc2')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.license.doc3')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.license.doc4')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-green-600" />{t('carTransfer.license.doc5')}</li>
                </ul>
              </div>

              <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4">
                <h4 className="font-bold text-green-700 dark:text-green-300 flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} />
                  {t('carTransfer.license.euTitle')}
                </h4>
                <p className="text-sm text-green-600 dark:text-green-400">{t('carTransfer.license.euDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Insurance */}
      {activeSection === 'insurance' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <Shield size={20} className="text-blue-600" />
              {t('carTransfer.insurance.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.insurance.intro')}</p>

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
                  <h4 className="font-bold text-red-700 dark:text-red-300 mb-2">{t('carTransfer.insurance.rcTitle')}</h4>
                  <p className="text-sm text-red-600 dark:text-red-400">{t('carTransfer.insurance.rcDesc')}</p>
                  <div className="mt-2 text-xs text-red-500">{t('carTransfer.insurance.rcNote')}</div>
                </div>
                <div className="bg-orange-50 dark:bg-orange-900/20 rounded-xl p-4 border border-orange-200 dark:border-orange-800">
                  <h4 className="font-bold text-orange-700 dark:text-orange-300 mb-2">{t('carTransfer.insurance.cascoTitle')}</h4>
                  <p className="text-sm text-orange-600 dark:text-orange-400">{t('carTransfer.insurance.cascoDesc')}</p>
                </div>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
                  <h4 className="font-bold text-blue-700 dark:text-blue-300 mb-2">{t('carTransfer.insurance.assistTitle')}</h4>
                  <p className="text-sm text-blue-600 dark:text-blue-400">{t('carTransfer.insurance.assistDesc')}</p>
                </div>
              </div>

              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4">
                <h4 className="font-bold text-slate-700 dark:text-slate-300 mb-3">{t('carTransfer.insurance.bonusTitle')}</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400">{t('carTransfer.insurance.bonusDesc')}</p>
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <Info size={16} className="mt-0.5 shrink-0 text-blue-600" />
                  <p className="text-sm text-blue-700 dark:text-blue-400">{t('carTransfer.insurance.tip')}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Costs Summary */}
      {activeSection === 'costs' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <CreditCard size={20} className="text-blue-600" />
              {t('carTransfer.costs.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.costs.intro')}</p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-3 px-4 font-bold text-slate-700 dark:text-slate-300">{t('carTransfer.costs.item')}</th>
                    <th className="text-right py-3 px-4 font-bold text-slate-700 dark:text-slate-300">{t('carTransfer.costs.amount')}</th>
                    <th className="text-left py-3 px-4 font-bold text-slate-700 dark:text-slate-300">{t('carTransfer.costs.notes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { item: t('carTransfer.costs.row1Item'), amount: t('carTransfer.costs.row1Amount'), note: t('carTransfer.costs.row1Note') },
                    { item: t('carTransfer.costs.row2Item'), amount: 'CHF 60–100', note: t('carTransfer.costs.row2Note') },
                    { item: t('carTransfer.costs.row3Item'), amount: 'CHF 30–50', note: t('carTransfer.costs.row3Note') },
                    { item: t('carTransfer.costs.row4Item'), amount: 'CHF 50–80', note: t('carTransfer.costs.row4Note') },
                    { item: t('carTransfer.costs.row5Item'), amount: 'CHF 40', note: t('carTransfer.costs.row5Note') },
                    { item: t('carTransfer.costs.row6Item'), amount: t('carTransfer.costs.row6Amount'), note: t('carTransfer.costs.row6Note') },
                    { item: t('carTransfer.costs.row7Item'), amount: 'CHF 35', note: t('carTransfer.costs.row7Note') },
                  ].map((row, i) => (
                    <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{row.item}</td>
                      <td className="py-3 px-4 text-right font-bold text-slate-800 dark:text-slate-200">{row.amount}</td>
                      <td className="py-3 px-4 text-slate-500 dark:text-slate-400">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-4">
              <div className="flex justify-between items-center">
                <span className="font-bold text-indigo-700 dark:text-indigo-300">{t('carTransfer.costs.total')}</span>
                <span className="text-xl font-bold text-indigo-700 dark:text-indigo-300">{t('carTransfer.costs.totalAmount')}</span>
              </div>
              <p className="text-xs text-indigo-500 mt-1">{t('carTransfer.costs.totalNote')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Checklist */}
      {activeSection === 'checklist' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <CheckCircle2 size={20} className="text-green-600" />
              {t('carTransfer.checklist.title')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">{t('carTransfer.checklist.intro')}</p>

            <div className="space-y-6">
              {[
                {
                  phase: t('carTransfer.checklist.phase1'),
                  color: 'blue',
                  items: [
                    t('carTransfer.checklist.p1i1'),
                    t('carTransfer.checklist.p1i2'),
                    t('carTransfer.checklist.p1i3'),
                    t('carTransfer.checklist.p1i4'),
                  ],
                },
                {
                  phase: t('carTransfer.checklist.phase2'),
                  color: 'amber',
                  items: [
                    t('carTransfer.checklist.p2i1'),
                    t('carTransfer.checklist.p2i2'),
                    t('carTransfer.checklist.p2i3'),
                  ],
                },
                {
                  phase: t('carTransfer.checklist.phase3'),
                  color: 'green',
                  items: [
                    t('carTransfer.checklist.p3i1'),
                    t('carTransfer.checklist.p3i2'),
                    t('carTransfer.checklist.p3i3'),
                    t('carTransfer.checklist.p3i4'),
                  ],
                },
              ].map((phase, pi) => (
                <div key={pi}>
                  <h4 className={`font-bold text-${phase.color === 'blue' ? 'blue' : phase.color === 'amber' ? 'amber' : 'green'}-700 dark:text-${phase.color === 'blue' ? 'blue' : phase.color === 'amber' ? 'amber' : 'green'}-300 mb-3`}>
                    {phase.phase}
                  </h4>
                  <div className="space-y-2">
                    {phase.items.map((item, ii) => (
                      <label key={ii} className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                        <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus-visible:ring-blue-500" aria-label={item} />
                        <span className="text-sm text-slate-700 dark:text-slate-300">{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FAQ */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4">{t('carTransfer.faq.title')}</h3>
        <div className="space-y-2">
          {faqItems.map((item, i) => (
            <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors" aria-expanded={expandedFaq === i}
              >
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 pr-4">{item.q}</span>
                {expandedFaq === i ? <ChevronUp size={16} className="shrink-0 text-slate-500 dark:text-slate-400" /> : <ChevronDown size={16} className="shrink-0 text-slate-500 dark:text-slate-400" />}
              </button>
              {expandedFaq === i && (
                <div className="px-4 pb-4 text-sm text-slate-600 dark:text-slate-400 border-t border-slate-100 dark:border-slate-700 pt-3">
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Useful Links */}
      <div className="bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-4">{t('carTransfer.links.title')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { label: t('carTransfer.links.bazg'), url: 'https://www.bazg.admin.ch/bazg/it/home.html' },
            { label: t('carTransfer.links.sc'), url: 'https://www4.ti.ch/di/sc' },
            { label: t('carTransfer.links.asa'), url: 'https://www.asa.ch/it/' },
            { label: t('carTransfer.links.tcs'), url: 'https://www.tcs.ch/it/' },
          ].map((link, i) => (
            <a
              key={i}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors text-sm text-blue-700 dark:text-blue-400 font-medium"
            >
              <ExternalLink size={14} />
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CarTransferGuide;
