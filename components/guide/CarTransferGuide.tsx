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
 <div className="bg-gradient-to-br from-accent-strong to-accent-strong-hover rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-3">
 <div className="p-3 bg-on-accent/20 rounded-xl">
 <Car size={28} />
 </div>
 <div>
 <h2 className="text-2xl font-bold">{t('carTransfer.title')}</h2>
 <p className="text-on-accent/70 text-sm mt-1">{t('carTransfer.subtitle')}</p>
 </div>
 </div>
 <div className="mt-4 bg-on-accent/10 rounded-xl p-4">
 <div className="flex items-start gap-2">
 <AlertCircle size={18} className="mt-0.5 shrink-0" />
 <p className="text-sm text-on-accent/70">{t('carTransfer.disclaimer')}</p>
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
 {activeSection === 'overview' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4">{t('carTransfer.overview.title')}</h3>
 <p className="text-subtle mb-6">{t('carTransfer.overview.intro')}</p>
 
 {/* Timeline */}
 <div className="space-y-4">
 <h4 className="text-sm font-bold text-body uppercase tracking-wide">{t('carTransfer.overview.timeline')}</h4>
 {[
 { step: '1', title: t('carTransfer.overview.step1Title'), desc: t('carTransfer.overview.step1Desc'), time: t('carTransfer.overview.step1Time') },
 { step: '2', title: t('carTransfer.overview.step2Title'), desc: t('carTransfer.overview.step2Desc'), time: t('carTransfer.overview.step2Time') },
 { step: '3', title: t('carTransfer.overview.step3Title'), desc: t('carTransfer.overview.step3Desc'), time: t('carTransfer.overview.step3Time') },
 { step: '4', title: t('carTransfer.overview.step4Title'), desc: t('carTransfer.overview.step4Desc'), time: t('carTransfer.overview.step4Time') },
 { step: '5', title: t('carTransfer.overview.step5Title'), desc: t('carTransfer.overview.step5Desc'), time: t('carTransfer.overview.step5Time') },
 ].map((item, i) => (
 <div key={i} className="flex gap-4">
 <div className="flex flex-col items-center">
 <div className="w-8 h-8 bg-accent-strong text-on-accent rounded-full flex items-center justify-center text-xs font-bold">{item.step}</div>
 {i < 4 && <div className="w-0.5 h-full bg-accent-subtle mt-1" />}
 </div>
 <div className="flex-1 pb-4">
 <h5 className="font-bold text-strong">{item.title}</h5>
 <p className="text-sm text-subtle mt-1">{item.desc}</p>
 <div className="flex items-center gap-1 mt-2 text-xs text-link">
 <Clock size={12} />
 {item.time}
 </div>
 </div>
 </div>
 ))}
 </div>
 </div>

 {/* Key deadlines */}
 <div className="bg-warning-subtle border border-warning-border rounded-2xl p-6">
 <h4 className="font-bold text-warning flex items-center gap-2 mb-3">
 <AlertCircle size={18} />
 {t('carTransfer.overview.deadlinesTitle')}
 </h4>
 <ul className="space-y-2 text-sm text-warning">
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
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <Landmark size={20} className="text-accent" />
 {t('carTransfer.customs.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.customs.intro')}</p>

 <div className="space-y-4">
 <div className="bg-neutral-subtle rounded-xl p-4">
 <h4 className="font-bold text-body mb-2">{t('carTransfer.customs.formTitle')}</h4>
 <p className="text-sm text-subtle mb-3">{t('carTransfer.customs.formDesc')}</p>
 <ul className="space-y-2 text-sm text-subtle">
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.customs.doc1')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.customs.doc2')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.customs.doc3')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.customs.doc4')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.customs.doc5')}</li>
 </ul>
 </div>

 <div className="bg-accent-subtle rounded-xl p-4">
 <h4 className="font-bold text-accent mb-2 flex items-center gap-2">
 <Info size={16} />
 {t('carTransfer.customs.taxTitle')}
 </h4>
 <p className="text-sm text-link mb-3">{t('carTransfer.customs.taxDesc')}</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <div className="bg-surface rounded-lg p-3 border border-accent-border">
 <div className="text-xs text-link font-semibold">{t('carTransfer.customs.ivaLabel')}</div>
 <div className="text-xl font-bold text-strong">8.1%</div>
 <div className="text-xs text-muted">{t('carTransfer.customs.ivaNote')}</div>
 </div>
 <div className="bg-surface rounded-lg p-3 border border-accent-border">
 <div className="text-xs text-link font-semibold">{t('carTransfer.customs.dutyLabel')}</div>
 <div className="text-xl font-bold text-strong">0 CHF</div>
 <div className="text-xs text-muted">{t('carTransfer.customs.dutyNote')}</div>
 </div>
 </div>
 </div>

 <div className="bg-success-subtle rounded-xl p-4">
 <h4 className="font-bold text-success mb-2 flex items-center gap-2">
 <CheckCircle2 size={16} />
 {t('carTransfer.customs.exemptionTitle')}
 </h4>
 <p className="text-sm text-success">{t('carTransfer.customs.exemptionDesc')}</p>
 <ul className="space-y-1 mt-2 text-sm text-success">
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
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <FileText size={20} className="text-accent" />
 {t('carTransfer.registration.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.registration.intro')}</p>

 <div className="space-y-4">
 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.registration.mfkTitle')}</h4>
 <p className="text-sm text-subtle mb-3">{t('carTransfer.registration.mfkDesc')}</p>
 <ul className="space-y-2 text-sm text-subtle">
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.registration.mfk1')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.registration.mfk2')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.registration.mfk3')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.registration.mfk4')}</li>
 </ul>
 </div>

 <div className="bg-neutral-subtle rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.registration.docsTitle')}</h4>
 <ul className="space-y-2 text-sm text-subtle">
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc1')}</li>
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc2')}</li>
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc3')}</li>
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc4')}</li>
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc5')}</li>
 <li className="flex items-start gap-2"><FileText size={14} className="mt-1 shrink-0 text-accent" />{t('carTransfer.registration.doc6')}</li>
 </ul>
 </div>

 <div className="bg-warning-subtle border border-warning-border rounded-xl p-4">
 <h4 className="font-bold text-warning flex items-center gap-2 mb-2">
 <AlertCircle size={16} />
 {t('carTransfer.registration.tiTitle')}
 </h4>
 <p className="text-xs text-warning">{t('carTransfer.registration.tiDesc')}</p>
 <a
 href="https://www4.ti.ch/di/sc/veicoli/immatricolazione"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-1 mt-2 text-sm text-warning underline hover:text-warning"
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
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <MapPin size={20} className="text-accent" />
 {t('carTransfer.plates.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.plates.intro')}</p>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.plates.typesTitle')}</h4>
 <ul className="space-y-3 text-sm">
 <li className="flex items-start gap-3">
 <div className="shrink-0 w-16 h-8 bg-surface border-2 border-edge rounded flex items-center justify-center text-xs font-bold text-body">TI ···</div>
 <div>
 <div className="font-semibold text-body">{t('carTransfer.plates.permanent')}</div>
 <div className="text-muted">{t('carTransfer.plates.permanentDesc')}</div>
 </div>
 </li>
 <li className="flex items-start gap-3">
 <div className="shrink-0 w-16 h-8 bg-accent-subtle border-2 border-accent-border rounded flex items-center justify-center text-xs font-bold text-accent">U ···</div>
 <div>
 <div className="font-semibold text-body">{t('carTransfer.plates.temp')}</div>
 <div className="text-muted">{t('carTransfer.plates.tempDesc')}</div>
 </div>
 </li>
 <li className="flex items-start gap-3">
 <div className="shrink-0 w-16 h-8 bg-warning-subtle border-2 border-warning rounded flex items-center justify-center text-xs font-bold text-warning">TI ···</div>
 <div>
 <div className="font-semibold text-body">{t('carTransfer.plates.transfer')}</div>
 <div className="text-muted">{t('carTransfer.plates.transferDesc')}</div>
 </div>
 </li>
 </ul>
 </div>

 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.plates.costTitle')}</h4>
 <div className="space-y-3 text-sm">
 <div className="flex justify-between items-center py-2 border-b border-edge">
 <span className="text-subtle">{t('carTransfer.plates.costPlate')}</span>
 <span className="font-bold text-strong">CHF 30–50</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-edge">
 <span className="text-subtle">{t('carTransfer.plates.costLicenseDoc')}</span>
 <span className="font-bold text-strong">CHF 50–80</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-edge">
 <span className="text-subtle">{t('carTransfer.plates.costVignette')}</span>
 <span className="font-bold text-strong">CHF 40</span>
 </div>
 <div className="flex justify-between items-center py-2">
 <span className="text-subtle">{t('carTransfer.plates.costTax')}</span>
 <span className="font-bold text-strong">{t('carTransfer.plates.costTaxVal')}</span>
 </div>
 </div>
 </div>
 </div>

 <div className="mt-4 bg-accent-subtle rounded-xl p-4">
 <div className="flex items-start gap-2">
 <Info size={16} className="mt-0.5 shrink-0 text-accent" />
 <p className="text-xs text-accent">{t('carTransfer.plates.italianNote')}</p>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* Driving License Exchange */}
 {activeSection === 'license' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <CreditCard size={20} className="text-accent" />
 {t('carTransfer.license.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.license.intro')}</p>

 <div className="space-y-4">
 <div className="bg-danger-subtle border border-danger-border rounded-xl p-4">
 <h4 className="font-bold text-danger flex items-center gap-2 mb-2">
 <AlertCircle size={16} />
 {t('carTransfer.license.deadlineTitle')}
 </h4>
 <p className="text-sm text-danger">{t('carTransfer.license.deadlineDesc')}</p>
 </div>

 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.license.processTitle')}</h4>
 <ol className="space-y-3 text-sm text-subtle">
 <li className="flex items-start gap-3">
 <span className="shrink-0 w-6 h-6 bg-accent-strong text-on-accent rounded-full flex items-center justify-center text-xs font-bold">1</span>
 <span>{t('carTransfer.license.step1')}</span>
 </li>
 <li className="flex items-start gap-3">
 <span className="shrink-0 w-6 h-6 bg-accent-strong text-on-accent rounded-full flex items-center justify-center text-xs font-bold">2</span>
 <span>{t('carTransfer.license.step2')}</span>
 </li>
 <li className="flex items-start gap-3">
 <span className="shrink-0 w-6 h-6 bg-accent-strong text-on-accent rounded-full flex items-center justify-center text-xs font-bold">3</span>
 <span>{t('carTransfer.license.step3')}</span>
 </li>
 <li className="flex items-start gap-3">
 <span className="shrink-0 w-6 h-6 bg-accent-strong text-on-accent rounded-full flex items-center justify-center text-xs font-bold">4</span>
 <span>{t('carTransfer.license.step4')}</span>
 </li>
 </ol>
 </div>

 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.license.docsTitle')}</h4>
 <ul className="space-y-2 text-sm text-subtle">
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.license.doc1')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.license.doc2')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.license.doc3')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.license.doc4')}</li>
 <li className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-1 shrink-0 text-success" />{t('carTransfer.license.doc5')}</li>
 </ul>
 </div>

 <div className="bg-success-subtle rounded-xl p-4">
 <h4 className="font-bold text-success flex items-center gap-2 mb-2">
 <CheckCircle2 size={16} />
 {t('carTransfer.license.euTitle')}
 </h4>
 <p className="text-sm text-success">{t('carTransfer.license.euDesc')}</p>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* Insurance */}
 {activeSection === 'insurance' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <Shield size={20} className="text-accent" />
 {t('carTransfer.insurance.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.insurance.intro')}</p>

 <div className="space-y-4">
 <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
 <div className="bg-danger-subtle rounded-xl p-4 border border-danger-border">
 <h4 className="font-bold text-danger mb-2">{t('carTransfer.insurance.rcTitle')}</h4>
 <p className="text-xs text-danger">{t('carTransfer.insurance.rcDesc')}</p>
 <div className="mt-2 text-xs text-danger">{t('carTransfer.insurance.rcNote')}</div>
 </div>
 <div className="bg-warning-subtle rounded-xl p-4 border border-warning-border">
 <h4 className="font-bold text-warning mb-2">{t('carTransfer.insurance.cascoTitle')}</h4>
 <p className="text-xs text-warning">{t('carTransfer.insurance.cascoDesc')}</p>
 </div>
 <div className="bg-accent-subtle rounded-xl p-4 border border-accent-border">
 <h4 className="font-bold text-accent mb-2">{t('carTransfer.insurance.assistTitle')}</h4>
 <p className="text-xs text-link">{t('carTransfer.insurance.assistDesc')}</p>
 </div>
 </div>

 <div className="bg-surface-alt rounded-xl p-4">
 <h4 className="font-bold text-body mb-3">{t('carTransfer.insurance.bonusTitle')}</h4>
 <p className="text-sm text-subtle">{t('carTransfer.insurance.bonusDesc')}</p>
 </div>

 <div className="bg-accent-subtle rounded-xl p-4">
 <div className="flex items-start gap-2">
 <Info size={16} className="mt-0.5 shrink-0 text-accent" />
 <p className="text-sm text-accent">{t('carTransfer.insurance.tip')}</p>
 </div>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* Costs Summary */}
 {activeSection === 'costs' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <CreditCard size={20} className="text-accent" />
 {t('carTransfer.costs.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.costs.intro')}</p>

 <div className="overflow-x-auto">
 <table className="w-full text-sm">
 <thead>
 <tr className="border-b border-edge">
 <th className="text-left py-3 px-4 font-bold text-body">{t('carTransfer.costs.item')}</th>
 <th className="text-right py-3 px-4 font-bold text-body">{t('carTransfer.costs.amount')}</th>
 <th className="text-left py-3 px-4 font-bold text-body">{t('carTransfer.costs.notes')}</th>
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
 <tr key={i} className="border-b border-edge">
 <td className="py-3 px-4 text-body">{row.item}</td>
 <td className="py-3 px-4 text-right font-bold text-strong">{row.amount}</td>
 <td className="py-3 px-4 text-muted">{row.note}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>

 <div className="mt-4 bg-accent-subtle rounded-xl p-4">
 <div className="flex justify-between items-center">
 <span className="font-bold text-accent">{t('carTransfer.costs.total')}</span>
 <span className="text-xl font-bold text-accent">{t('carTransfer.costs.totalAmount')}</span>
 </div>
 <p className="text-xs text-accent mt-1">{t('carTransfer.costs.totalNote')}</p>
 </div>
 </div>
 </div>
 )}

 {/* Checklist */}
 {activeSection === 'checklist' && (
 <div className="space-y-4 animate-fade-in">
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <CheckCircle2 size={20} className="text-success" />
 {t('carTransfer.checklist.title')}
 </h3>
 <p className="text-subtle mb-6">{t('carTransfer.checklist.intro')}</p>

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
 <h4 className={`font-bold mb-3 ${phase.color === 'blue' ? 'text-info' : phase.color === 'amber' ? 'text-warning' : 'text-success'}`}>
 {phase.phase}
 </h4>
 <div className="space-y-2">
 {phase.items.map((item, ii) => (
 <label key={ii} className="flex items-start gap-3 p-3 bg-surface-alt rounded-lg cursor-pointer hover:bg-surface-raised transition-colors">
 <input type="checkbox" className="mt-1 h-4 w-4 rounded border-edge text-accent focus-visible:ring-accent" aria-label={item} />
 <span className="text-sm text-body">{item}</span>
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
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4">{t('carTransfer.faq.title')}</h3>
 <div className="space-y-2">
 {faqItems.map((item, i) => (
 <div key={i} className="border border-edge rounded-xl overflow-hidden">
 <button
 onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
 className="w-full flex items-center justify-between p-4 text-left hover:bg-surface-raised/50 transition-colors" aria-expanded={expandedFaq === i}
 >
 <span className="text-sm font-semibold text-body pr-4">{item.q}</span>
 {expandedFaq === i ? <ChevronUp size={16} className="shrink-0 text-muted" /> : <ChevronDown size={16} className="shrink-0 text-muted" />}
 </button>
 {expandedFaq === i && (
 <div className="px-4 pb-4 text-sm text-subtle border-t border-edge pt-3">
 {item.a}
 </div>
 )}
 </div>
 ))}
 </div>
 </div>

 {/* Useful Links */}
 <div className="bg-surface-alt rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4">{t('carTransfer.links.title')}</h3>
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
 className="flex items-center gap-2 p-3 bg-surface rounded-xl border border-edge hover:border-accent transition-colors text-sm text-accent font-medium"
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
