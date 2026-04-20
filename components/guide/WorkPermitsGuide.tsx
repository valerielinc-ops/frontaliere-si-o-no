import React, { useState, useEffect } from 'react';
import { Shield, Clock, FileText, Users, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Briefcase, Globe, Calendar, Info, ArrowRight, Building2, AlertTriangle, RefreshCw, Scale } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';
import { scrollToAnchor, parsePermitSectionHash, getPermitSectionSlug, type PermitSectionKey } from '@/services/router';

interface PermitType {
 id: 'G' | 'B' | 'C' | 'L';
 name: string;
 fullName: string;
 color: string;
 icon: string;
 duration: string;
 forWhom: string;
 description: string;
 requirements: string[];
 documents: string[];
 processingTime: string;
 cost: string;
 renewal: string;
 rights: string[];
 limitations: string[];
 familyReunion: string;
 taxImplications: string;
 tips: string[];
}

function getPermits(t: (key: string) => string): PermitType[] {
 return [
 {
 id: 'G',
 name: t('permits.g.name'),
 fullName: t('permits.g.fullName'),
 color: 'from-info-strong to-success-strong',
 icon: '🔵',
 duration: t('permits.g.duration'),
 forWhom: t('permits.g.forWhom'),
 description: t('permits.g.description'),
 requirements: [
 t('permits.g.req1'),
 t('permits.g.req2'),
 t('permits.g.req3'),
 t('permits.g.req4'),
 t('permits.g.req5'),
 ],
 documents: [
 t('permits.g.doc1'),
 t('permits.g.doc2'),
 t('permits.g.doc3'),
 t('permits.g.doc4'),
 t('permits.g.doc5'),
 t('permits.g.doc6'),
 ],
 processingTime: t('permits.g.processingTime'),
 cost: t('permits.g.cost'),
 renewal: t('permits.g.renewal'),
 rights: [
 t('permits.g.right1'),
 t('permits.g.right2'),
 t('permits.g.right3'),
 t('permits.g.right4'),
 t('permits.g.right5'),
 ],
 limitations: [
 t('permits.g.limit1'),
 t('permits.g.limit2'),
 t('permits.g.limit3'),
 t('permits.g.limit4'),
 t('permits.g.limit5'),
 ],
 familyReunion: t('permits.g.familyReunion'),
 taxImplications: t('permits.g.taxImplications'),
 tips: [
 t('permits.g.tip1'),
 t('permits.g.tip2'),
 t('permits.g.tip3'),
 t('permits.g.tip4'),
 ],
 },
 {
 id: 'B',
 name: t('permits.b.name'),
 fullName: t('permits.b.fullName'),
 color: 'from-success-strong to-info-strong',
 icon: '🟢',
 duration: t('permits.b.duration'),
 forWhom: t('permits.b.forWhom'),
 description: t('permits.b.description'),
 requirements: [
 t('permits.b.req1'),
 t('permits.b.req2'),
 t('permits.b.req3'),
 t('permits.b.req4'),
 t('permits.b.req5'),
 ],
 documents: [
 t('permits.b.doc1'),
 t('permits.b.doc2'),
 t('permits.b.doc3'),
 t('permits.b.doc4'),
 t('permits.b.doc5'),
 t('permits.b.doc6'),
 t('permits.b.doc7'),
 ],
 processingTime: t('permits.b.processingTime'),
 cost: t('permits.b.cost'),
 renewal: t('permits.b.renewal'),
 rights: [
 t('permits.b.right1'),
 t('permits.b.right2'),
 t('permits.b.right3'),
 t('permits.b.right4'),
 t('permits.b.right5'),
 t('permits.b.right6'),
 ],
 limitations: [
 t('permits.b.limit1'),
 t('permits.b.limit2'),
 t('permits.b.limit3'),
 t('permits.b.limit4'),
 ],
 familyReunion: t('permits.b.familyReunion'),
 taxImplications: t('permits.b.taxImplications'),
 tips: [
 t('permits.b.tip1'),
 t('permits.b.tip2'),
 t('permits.b.tip3'),
 t('permits.b.tip4'),
 ],
 },
 {
 id: 'C',
 name: t('permits.c.name'),
 fullName: t('permits.c.fullName'),
 color: 'from-warning-strong to-warning-strong',
 icon: '🟠',
 duration: t('permits.c.duration'),
 forWhom: t('permits.c.forWhom'),
 description: t('permits.c.description'),
 requirements: [
 t('permits.c.req1'),
 t('permits.c.req2'),
 t('permits.c.req3'),
 t('permits.c.req4'),
 t('permits.c.req5'),
 ],
 documents: [
 t('permits.c.doc1'),
 t('permits.c.doc2'),
 t('permits.c.doc3'),
 t('permits.c.doc4'),
 t('permits.c.doc5'),
 t('permits.c.doc6'),
 ],
 processingTime: t('permits.c.processingTime'),
 cost: t('permits.c.cost'),
 renewal: t('permits.c.renewal'),
 rights: [
 t('permits.c.right1'),
 t('permits.c.right2'),
 t('permits.c.right3'),
 t('permits.c.right4'),
 t('permits.c.right5'),
 t('permits.c.right6'),
 t('permits.c.right7'),
 ],
 limitations: [
 t('permits.c.limit1'),
 t('permits.c.limit2'),
 t('permits.c.limit3'),
 t('permits.c.limit4'),
 ],
 familyReunion: t('permits.c.familyReunion'),
 taxImplications: t('permits.c.taxImplications'),
 tips: [
 t('permits.c.tip1'),
 t('permits.c.tip2'),
 t('permits.c.tip3'),
 t('permits.c.tip4'),
 ],
 },
 {
 id: 'L',
 name: t('permits.l.name'),
 fullName: t('permits.l.fullName'),
 color: 'from-info-strong to-info-strong',
 icon: '🟣',
 duration: t('permits.l.duration'),
 forWhom: t('permits.l.forWhom'),
 description: t('permits.l.description'),
 requirements: [
 t('permits.l.req1'),
 t('permits.l.req2'),
 t('permits.l.req3'),
 t('permits.l.req4'),
 ],
 documents: [
 t('permits.l.doc1'),
 t('permits.l.doc2'),
 t('permits.l.doc3'),
 t('permits.l.doc4'),
 t('permits.l.doc5'),
 ],
 processingTime: t('permits.l.processingTime'),
 cost: t('permits.l.cost'),
 renewal: t('permits.l.renewal'),
 rights: [
 t('permits.l.right1'),
 t('permits.l.right2'),
 t('permits.l.right3'),
 ],
 limitations: [
 t('permits.l.limit1'),
 t('permits.l.limit2'),
 t('permits.l.limit3'),
 t('permits.l.limit4'),
 t('permits.l.limit5'),
 ],
 familyReunion: t('permits.l.familyReunion'),
 taxImplications: t('permits.l.taxImplications'),
 tips: [
 t('permits.l.tip1'),
 t('permits.l.tip2'),
 t('permits.l.tip3'),
 t('permits.l.tip4'),
 ],
 },
 ];
}

const WorkPermitsGuide: React.FC = () => {
 const { t } = useTranslation();
 const [selectedPermit, setSelectedPermit] = useState<'G' | 'B' | 'C' | 'L'>('G');
 const [expandedSection, setExpandedSection] = useState<string | null>(() => {
 // Auto-expand section matching URL hash fragment (locale-aware)
 return parsePermitSectionHash();
 });

 // Scroll to the anchored section on mount + listen for hash changes
 useEffect(() => {
 if (expandedSection) {
 scrollToAnchor(getPermitSectionSlug(expandedSection as PermitSectionKey));
 }
 // Re-read hash when it changes (e.g. popstate, internal navigation)
 const onHashChange = () => {
 const section = parsePermitSectionHash();
 if (section) {
 setExpandedSection(section);
 // Delay scroll to let React render the expanded content
 requestAnimationFrame(() => {
 scrollToAnchor(getPermitSectionSlug(section));
 });
 }
 };
 window.addEventListener('hashchange', onHashChange);
 return () => window.removeEventListener('hashchange', onHashChange);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const permits = getPermits(t);
 const permit = permits.find(p => p.id === selectedPermit)!;

 const toggleSection = (section: string) => {
 const next = expandedSection === section ? null : section;
 setExpandedSection(next);
 // Update URL hash with locale-translated slug
 if (next) {
 const slug = getPermitSectionSlug(next as PermitSectionKey);
 history.replaceState(null, '', `#${slug}`);
 } else {
 history.replaceState(null, '', window.location.pathname);
 }
 Analytics.trackUIInteraction('guida', 'permessi', 'sezione_dettaglio', 'toggle', `${selectedPermit}:${section}`);
 };

 const Section = ({ id, icon: Icon, title, children }: { id: string; icon: any; title: string; children: React.ReactNode }) => {
 const isOpen = expandedSection === id;
 const slug = getPermitSectionSlug(id as PermitSectionKey);
 return (
 <div id={slug} className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <div
 role="button"
 tabIndex={0}
 aria-expanded={isOpen}
 onClick={() => toggleSection(id)}
 onKeyDown={(e) => {
 if (e.key === 'Enter' || e.key === ' ') {
 e.preventDefault();
 toggleSection(id);
 }
 }}
 className="flex items-center justify-between p-4 cursor-pointer hover:bg-surface-raised transition-colors"
 >
 <div className="flex items-center gap-3">
 <Icon size={20} className="text-muted" />
 <h4 className="font-bold text-strong">{title}</h4>
 </div>
 {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
 </div>
 {isOpen && (
 <div className="p-4 pt-0 animate-fade-in border-t border-edge">
 {children}
 </div>
 )}
 </div>
 );
 };

 return (
 <div className="space-y-6 animate-fade-in">
 {/* Header */}
 <div className="bg-gradient-to-br from-info-strong via-success-strong to-warm-600 rounded-3xl p-5 sm:p-8 text-on-accent shadow-2xl">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-on-accent/15 rounded-2xl">
 <Shield size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-extrabold font-display">{t('permits.pageTitle')}</h1>
 <p className="text-on-accent/80 mt-1">{t('permits.pageSubtitle')}</p>
 </div>
 </div>
 </div>

 {/* Permit Selector */}
 <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
 {permits.map(p => (
 <button
 key={p.id}
 onClick={() => {
 setSelectedPermit(p.id);
 setExpandedSection(null);
 Analytics.trackUIInteraction('guida', 'permessi', 'tipo_permesso', 'seleziona', p.id);
 }}
 className={`p-4 rounded-2xl border-2 transition-[color,background-color,border-color,box-shadow] text-left ${
 selectedPermit === p.id
 ? `border-transparent bg-gradient-to-br ${p.color} text-on-accent shadow-lg scale-[1.02]`
 : 'border-edge bg-surface hover:border-edge'
 }`}
 >
 <div className="text-2xl mb-1">{p.icon}</div>
 <div className="font-bold font-display text-lg">{p.name}</div>
 <div className={`text-xs mt-0.5 ${selectedPermit === p.id ? 'text-on-accent/90' : 'text-muted'}`}>{p.fullName}</div>
 <div className={`text-xs mt-2 font-bold ${selectedPermit === p.id ? 'text-on-accent/70' : 'text-muted'}`}>{p.duration}</div>
 </button>
 ))}
 </div>

 {/* Selected Permit Details */}
 <div className="space-y-3">
 {/* Overview */}
 <div className={`bg-gradient-to-r ${permit.color} rounded-2xl p-5 sm:p-6 text-on-accent`}>
 <div className="flex items-center gap-3 mb-3">
 <span className="text-4xl">{permit.icon}</span>
 <div>
 <h2 className="text-2xl font-bold font-display">{permit.name} — {permit.fullName}</h2>
 <p className="text-on-accent/90 text-sm mt-1">{permit.forWhom}</p>
 </div>
 </div>
 <p className="text-on-accent/90 text-sm leading-relaxed">{permit.description}</p>
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
 <div className="bg-on-accent/10 rounded-xl p-3">
 <Clock size={14} className="text-on-accent/70 mb-1" />
 <div className="text-xs text-on-accent/70">{t('permits.duration')}</div>
 <div className="font-bold text-sm">{permit.duration}</div>
 </div>
 <div className="bg-on-accent/10 rounded-xl p-3">
 <Calendar size={14} className="text-on-accent/70 mb-1" />
 <div className="text-xs text-on-accent/70">{t('permits.processingTime')}</div>
 <div className="font-bold text-sm">{permit.processingTime}</div>
 </div>
 <div className="bg-on-accent/10 rounded-xl p-3">
 <Building2 size={14} className="text-on-accent/70 mb-1" />
 <div className="text-xs text-on-accent/70">{t('permits.cost')}</div>
 <div className="font-bold text-sm">{permit.cost}</div>
 </div>
 </div>
 </div>

 {/* Sections */}
 <Section id="requirements" icon={CheckCircle2} title={t('permits.requirements')}>
 <ul className="space-y-2 mt-2">
 {permit.requirements.map((req, i) => (
 <li key={i} className="flex items-start gap-2 text-sm text-body">
 <CheckCircle2 size={16} className="text-success flex-shrink-0 mt-0.5" />
 {req}
 </li>
 ))}
 </ul>
 </Section>

 <Section id="documents" icon={FileText} title={t('permits.documents')}>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
 {permit.documents.map((doc, i) => (
 <div key={i} className="flex items-center gap-2 p-2.5 bg-surface-alt rounded-lg text-sm text-body">
 <FileText size={14} className="text-accent flex-shrink-0" />
 {doc}
 </div>
 ))}
 </div>
 </Section>

 <Section id="rights" icon={Shield} title={t('permits.sectionRights')}>
 <ul className="space-y-2 mt-2">
 {permit.rights.map((r, i) => (
 <li key={i} className="flex items-start gap-2 text-sm text-body">
 <ArrowRight size={14} className="text-success flex-shrink-0 mt-1" />
 {r}
 </li>
 ))}
 </ul>
 </Section>

 <Section id="limitations" icon={AlertCircle} title={t('permits.sectionLimitations')}>
 <ul className="space-y-2 mt-2">
 {permit.limitations.map((l, i) => (
 <li key={i} className="flex items-start gap-2 text-sm text-body">
 <AlertCircle size={14} className="text-warning flex-shrink-0 mt-0.5" />
 {l}
 </li>
 ))}
 </ul>
 </Section>

 <Section id="family" icon={Users} title={t('permits.sectionFamily')}>
 <p className="text-sm text-body mt-2">{permit.familyReunion}</p>
 </Section>

 <Section id="tax" icon={Building2} title={t('permits.sectionTax')}>
 <p className="text-sm text-body mt-2">{permit.taxImplications}</p>
 </Section>

 {/* Vecchio vs Nuovo Frontaliere — G permit only */}
 {selectedPermit === 'G' && (
 <Section id="status-change" icon={RefreshCw} title={t('permits.g.statusTitle')}>
 <div className="space-y-4 mt-2">
 {/* Intro */}
 <p className="text-sm text-body">{t('permits.g.statusIntro')}</p>

 {/* Vecchio definition */}
 <div className="bg-accent-subtle border border-accent-border rounded-xl p-5">
 <h5 className="font-bold text-accent text-sm flex items-center gap-2 mb-2">
 <Shield size={16} />
 {t('permits.g.oldLabel')}
 </h5>
 <p className="text-sm text-body mb-2">{t('permits.g.oldDefinition')}</p>
 <div className="bg-surface rounded-lg p-3 text-xs text-subtle">
 <span className="font-bold text-link">{t('permits.g.regimeLabel')}:</span> {t('permits.g.oldRegime')}
 </div>
 </div>

 {/* Nuovo definition */}
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-5">
 <h5 className="font-bold text-warning text-sm flex items-center gap-2 mb-2">
 <AlertCircle size={16} />
 {t('permits.g.newLabel')}
 </h5>
 <p className="text-sm text-body mb-2">{t('permits.g.newDefinition')}</p>
 <div className="bg-surface rounded-lg p-3 text-xs text-subtle">
 <span className="font-bold text-warning">{t('permits.g.regimeLabel')}:</span> {t('permits.g.newRegime')}
 </div>
 </div>

 {/* G → B → G scenario */}
 <div className="bg-accent-subtle border border-accent-border rounded-xl p-5">
 <h5 className="font-bold text-accent text-sm flex items-center gap-2 mb-2">
 <Scale size={16} />
 {t('permits.g.switchTitle')}
 </h5>
 <p className="text-sm text-body mb-3">{t('permits.g.switchQuestion')}</p>
 <div className="bg-surface rounded-lg p-3 space-y-2">
 <p className="text-sm font-bold text-success">{t('permits.g.switchAnswer')}</p>
 <p className="text-sm text-body">{t('permits.g.switchExplanation')}</p>
 </div>
 <div className="mt-3 flex items-start gap-2 bg-warning-subtle rounded-lg p-3">
 <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
 <p className="text-xs text-warning font-medium">{t('permits.g.switchWarning')}</p>
 </div>
 </div>

 {/* Sources */}
 <div className="bg-neutral-subtle rounded-xl p-5 flex items-start gap-3">
 <FileText size={16} className="text-muted flex-shrink-0 mt-0.5" />
 <p className="text-xs text-subtle">{t('permits.g.switchNote')}</p>
 </div>
 </div>
 </Section>
 )}

 <Section id="renewal" icon={Clock} title={t('permits.sectionRenewal')}>
 <p className="text-sm text-body mt-2">{permit.renewal}</p>
 </Section>

 <Section id="tips" icon={Info} title={t('permits.sectionTips')}>
 <ul className="space-y-2 mt-2">
 {permit.tips.map((tip, i) => (
 <li key={i} className="flex items-start gap-2 text-sm text-body">
 <span className="text-base">💡</span>
 {tip}
 </li>
 ))}
 </ul>
 </Section>
 </div>

 {/* Comparison table */}
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-6">
 <h3 className="text-lg font-bold font-display text-strong mb-4 flex items-center gap-2">
 <Globe size={20} className="text-accent" />
 {t('permits.comparisonTitle')}
 </h3>
 <div className="relative overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
 <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-surface sm:hidden z-10" />
 <table className="w-full text-sm min-w-[600px] sm:min-w-0">
 <thead>
 <tr className="border-b-2 border-edge">
 <th className="text-left py-3 text-muted font-bold">{t('permits.feature')}</th>
 {permits.map(p => (
 <th key={p.id} className="text-center py-3 font-bold">
 <span className="text-lg">{p.icon}</span>
 <div className={`text-xs mt-1 ${selectedPermit === p.id ? 'text-link' : 'text-subtle'}`}>{p.name}</div>
 </th>
 ))}
 </tr>
 </thead>
 <tbody className="text-body">
 {[
 { label: t('permits.cmp.residenceCH'), values: ['❌', '✅', '✅', '✅'] },
 { label: t('permits.cmp.duration'), values: [t('permits.cmp.5years'), t('permits.cmp.5years'), '∞', t('permits.cmp.max1year')] },
 { label: t('permits.cmp.jobChange'), values: [t('permits.cmp.limited'), t('permits.cmp.free'), t('permits.cmp.free'), '❌'] },
 { label: t('permits.cmp.familyCH'), values: ['❌', '✅', '✅', t('permits.cmp.limited')] },
 { label: t('permits.cmp.toPermitC'), values: ['❌', t('permits.cmp.5yearsParens'), '—', '❌'] },
 { label: t('permits.cmp.selfEmployed'), values: [t('permits.cmp.limited'), '✅', '✅', '❌'] },
 { label: t('permits.cmp.pillar3'), values: ['❌', '✅', '✅', '❌'] },
 ].map((row, i) => (
 <tr key={i} className="border-b border-edge">
 <td className="py-2.5 font-medium">{row.label}</td>
 {row.values.map((v, j) => (
 <td key={j} className="text-center py-2.5">{v}</td>
 ))}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 );
};

export default WorkPermitsGuide;
