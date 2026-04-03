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
      color: 'from-teal-500 to-emerald-600',
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
      color: 'from-emerald-500 to-teal-600',
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
      color: 'from-amber-500 to-orange-600',
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
      color: 'from-purple-500 to-pink-600',
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
      <div id={slug} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => toggleSection(id)}
          onKeyDown={(e) => e.key === 'Enter' && toggleSection(id)}
          className="flex items-center justify-between p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Icon size={20} className="text-slate-500 dark:text-slate-400" />
            <h4 className="font-bold text-slate-800 dark:text-slate-100">{title}</h4>
          </div>
          {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
        {isOpen && (
          <div className="p-4 pt-0 animate-fade-in border-t border-slate-100 dark:border-slate-700">
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-teal-600 via-teal-500 to-emerald-600 rounded-3xl p-5 sm:p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 dark:bg-white/8 rounded-2xl">
            <Shield size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold">{t('permits.pageTitle')}</h1>
            <p className="text-teal-100 mt-1">{t('permits.pageSubtitle')}</p>
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
            className={`p-4 rounded-2xl border-2 transition-all text-left ${
              selectedPermit === p.id
                ? `border-transparent bg-gradient-to-br ${p.color} text-white shadow-lg scale-[1.02]`
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-600'
            }`}
          >
            <div className="text-2xl mb-1">{p.icon}</div>
            <div className="font-bold text-lg">{p.name}</div>
            <div className={`text-xs mt-0.5 ${selectedPermit === p.id ? 'text-white/90' : 'text-slate-500 dark:text-slate-400'}`}>{p.fullName}</div>
            <div className={`text-xs mt-2 font-bold ${selectedPermit === p.id ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}`}>{p.duration}</div>
          </button>
        ))}
      </div>

      {/* Selected Permit Details */}
      <div className="space-y-3">
        {/* Overview */}
        <div className={`bg-gradient-to-r ${permit.color} rounded-2xl p-4 sm:p-6 text-white`}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-4xl">{permit.icon}</span>
            <div>
              <h2 className="text-2xl font-bold">{permit.name} — {permit.fullName}</h2>
              <p className="text-white/90 text-sm mt-1">{permit.forWhom}</p>
            </div>
          </div>
          <p className="text-white/90 text-sm leading-relaxed">{permit.description}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <div className="bg-white/15 dark:bg-white/5 rounded-xl p-3">
              <Clock size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">{t('permits.duration')}</div>
              <div className="font-bold text-sm">{permit.duration}</div>
            </div>
            <div className="bg-white/15 dark:bg-white/5 rounded-xl p-3">
              <Calendar size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">{t('permits.processingTime')}</div>
              <div className="font-bold text-sm">{permit.processingTime}</div>
            </div>
            <div className="bg-white/15 dark:bg-white/5 rounded-xl p-3">
              <Building2 size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">{t('permits.cost')}</div>
              <div className="font-bold text-sm">{permit.cost}</div>
            </div>
          </div>
        </div>

        {/* Sections */}
        <Section id="requirements" icon={CheckCircle2} title={t('permits.requirements')}>
          <ul className="space-y-2 mt-2">
            {permit.requirements.map((req, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                {req}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="documents" icon={FileText} title={t('permits.documents')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            {permit.documents.map((doc, i) => (
              <div key={i} className="flex items-center gap-2 p-2.5 bg-slate-50 dark:bg-slate-900 rounded-lg text-sm text-slate-700 dark:text-slate-300">
                <FileText size={14} className="text-blue-500 flex-shrink-0" />
                {doc}
              </div>
            ))}
          </div>
        </Section>

        <Section id="rights" icon={Shield} title={t('permits.sectionRights')}>
          <ul className="space-y-2 mt-2">
            {permit.rights.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <ArrowRight size={14} className="text-emerald-500 flex-shrink-0 mt-1" />
                {r}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="limitations" icon={AlertCircle} title={t('permits.sectionLimitations')}>
          <ul className="space-y-2 mt-2">
            {permit.limitations.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <AlertCircle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                {l}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="family" icon={Users} title={t('permits.sectionFamily')}>
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.familyReunion}</p>
        </Section>

        <Section id="tax" icon={Building2} title={t('permits.sectionTax')}>
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.taxImplications}</p>
        </Section>

        {/* Vecchio vs Nuovo Frontaliere — G permit only */}
        {selectedPermit === 'G' && (
          <Section id="status-change" icon={RefreshCw} title={t('permits.g.statusTitle')}>
            <div className="space-y-4 mt-2">
              {/* Intro */}
              <p className="text-sm text-slate-700 dark:text-slate-300">{t('permits.g.statusIntro')}</p>

              {/* Vecchio definition */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
                <h5 className="font-bold text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2 mb-2">
                  <Shield size={16} />
                  {t('permits.g.oldLabel')}
                </h5>
                <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">{t('permits.g.oldDefinition')}</p>
                <div className="bg-white dark:bg-slate-800 rounded-lg p-3 text-xs text-slate-600 dark:text-slate-400">
                  <span className="font-bold text-blue-600 dark:text-blue-400">{t('permits.g.regimeLabel')}:</span> {t('permits.g.oldRegime')}
                </div>
              </div>

              {/* Nuovo definition */}
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
                <h5 className="font-bold text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  {t('permits.g.newLabel')}
                </h5>
                <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">{t('permits.g.newDefinition')}</p>
                <div className="bg-white dark:bg-slate-800 rounded-lg p-3 text-xs text-slate-600 dark:text-slate-400">
                  <span className="font-bold text-amber-600 dark:text-amber-400">{t('permits.g.regimeLabel')}:</span> {t('permits.g.newRegime')}
                </div>
              </div>

              {/* G → B → G scenario */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
                <h5 className="font-bold text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2 mb-2">
                  <Scale size={16} />
                  {t('permits.g.switchTitle')}
                </h5>
                <p className="text-sm text-slate-700 dark:text-slate-300 mb-3">{t('permits.g.switchQuestion')}</p>
                <div className="bg-white dark:bg-slate-800 rounded-lg p-3 space-y-2">
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{t('permits.g.switchAnswer')}</p>
                  <p className="text-sm text-slate-700 dark:text-slate-300">{t('permits.g.switchExplanation')}</p>
                </div>
                <div className="mt-3 flex items-start gap-2 bg-amber-50 dark:bg-amber-900/30 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">{t('permits.g.switchWarning')}</p>
                </div>
              </div>

              {/* Sources */}
              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 flex items-start gap-3">
                <FileText size={16} className="text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-slate-600 dark:text-slate-400">{t('permits.g.switchNote')}</p>
              </div>
            </div>
          </Section>
        )}

        <Section id="renewal" icon={Clock} title={t('permits.sectionRenewal')}>
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.renewal}</p>
        </Section>

        <Section id="tips" icon={Info} title={t('permits.sectionTips')}>
          <ul className="space-y-2 mt-2">
            {permit.tips.map((tip, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <span className="text-base">💡</span>
                {tip}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {/* Comparison table */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Globe size={20} className="text-blue-600" />
          {t('permits.comparisonTitle')}
        </h3>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b-2 border-slate-200 dark:border-slate-700">
              <th className="text-left py-3 text-slate-500 dark:text-slate-400 font-bold">{t('permits.feature')}</th>
              {permits.map(p => (
                <th key={p.id} className="text-center py-3 font-bold">
                  <span className="text-lg">{p.icon}</span>
                  <div className={`text-xs mt-1 ${selectedPermit === p.id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`}>{p.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-300">
            {[
              { label: t('permits.cmp.residenceCH'), values: ['❌', '✅', '✅', '✅'] },
              { label: t('permits.cmp.duration'), values: [t('permits.cmp.5years'), t('permits.cmp.5years'), '∞', t('permits.cmp.max1year')] },
              { label: t('permits.cmp.jobChange'), values: [t('permits.cmp.limited'), t('permits.cmp.free'), t('permits.cmp.free'), '❌'] },
              { label: t('permits.cmp.familyCH'), values: ['❌', '✅', '✅', t('permits.cmp.limited')] },
              { label: t('permits.cmp.toPermitC'), values: ['❌', t('permits.cmp.5yearsParens'), '—', '❌'] },
              { label: t('permits.cmp.selfEmployed'), values: [t('permits.cmp.limited'), '✅', '✅', '❌'] },
              { label: t('permits.cmp.pillar3'), values: ['❌', '✅', '✅', '❌'] },
            ].map((row, i) => (
              <tr key={i} className="border-b border-slate-100 dark:border-slate-700">
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
