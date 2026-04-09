import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { unlockAchievement, addXp } from '@/services/gamificationService';
import { CheckCircle2, Circle, ChevronDown, ChevronUp, Flag, Sparkles, ExternalLink, Clock, AlertCircle, Trophy, User, Briefcase } from 'lucide-react';
import { loadUserProfile } from '@/components/pages/UserProfile';
import type { UserProfileData } from '@/components/pages/UserProfile';
import { useNavigation } from '@/services/NavigationContext';
import { buildPath } from '@/services/router';
import { Analytics } from '@/services/analytics';

// ─── Checklist Steps ─────────────────────────────────────────────────────

interface ChecklistStep {
  id: string;
  category: 'documents' | 'work' | 'finance' | 'health' | 'life';
  icon: string;
  estimatedDays: string;
  links?: { label: string; url: string }[];
  substeps?: string[];
  /** Show a primary internal job-board CTA before external links */
  jobBoardCta?: true;
}

const CHECKLIST_STEPS: ChecklistStep[] = [
  // Documents
  {
    id: 'find_job',
    category: 'documents',
    icon: '💼',
    estimatedDays: '1-3 mesi',
    jobBoardCta: true,
    links: [
      { label: 'jobs.ch', url: 'https://www.jobs.ch' },
      { label: 'Indeed Svizzera', url: 'https://www.indeed.ch' },
    ],
  },
  {
    id: 'permit_g',
    category: 'documents',
    icon: '🪪',
    estimatedDays: '2-4 settimane',
    substeps: ['permit_g_sub1', 'permit_g_sub2', 'permit_g_sub3', 'permit_g_sub4'],
    links: [
      { label: 'SEM - Permessi', url: 'https://www.sem.admin.ch/sem/it/home/themen/arbeit.html' },
    ],
  },
  {
    id: 'aire',
    category: 'documents',
    icon: '📋',
    estimatedDays: '1 giorno',
    substeps: ['aire_sub1', 'aire_sub2'],
  },
  // Work
  {
    id: 'open_bank_ch',
    category: 'finance',
    icon: '🏦',
    estimatedDays: '1-2 settimane',
    substeps: ['bank_sub1', 'bank_sub2', 'bank_sub3'],
    links: [
      { label: 'PostFinance', url: 'https://www.postfinance.ch' },
      { label: 'UBS', url: 'https://www.ubs.com/ch/it.html' },
    ],
  },
  {
    id: 'choose_insurance',
    category: 'health',
    icon: '🏥',
    estimatedDays: '1-2 settimane',
    substeps: ['insurance_sub1', 'insurance_sub2', 'insurance_sub3'],
    links: [
      { label: 'Comparis', url: 'https://www.comparis.ch/krankenkassen' },
    ],
  },
  {
    id: 'sim_mobile',
    category: 'life',
    icon: '📱',
    estimatedDays: '1 giorno',
    substeps: ['sim_sub1', 'sim_sub2'],
  },
  {
    id: 'transport_plan',
    category: 'life',
    icon: '🚗',
    estimatedDays: '1 settimana',
    substeps: ['transport_sub1', 'transport_sub2', 'transport_sub3'],
  },
  {
    id: 'first_salary',
    category: 'work',
    icon: '💰',
    estimatedDays: 'Fine 1° mese',
    substeps: ['salary_sub1', 'salary_sub2', 'salary_sub3'],
  },
  {
    id: 'avs_number',
    category: 'documents',
    icon: '🔢',
    estimatedDays: '2-4 settimane',
  },
  {
    id: 'tax_setup',
    category: 'finance',
    icon: '📊',
    estimatedDays: 'Entro 1° anno',
    substeps: ['tax_sub1', 'tax_sub2', 'tax_sub3'],
  },
  {
    id: 'pillar3',
    category: 'finance',
    icon: '🏦',
    estimatedDays: 'Entro 1° anno',
    substeps: ['pillar3_sub1', 'pillar3_sub2'],
  },
  {
    id: 'first_730',
    category: 'finance',
    icon: '📄',
    estimatedDays: 'Aprile anno successivo',
    substeps: ['730_sub1', '730_sub2', '730_sub3'],
  },
];

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  documents: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800' },
  work: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-800' },
  finance: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800' },
  health: { bg: 'bg-rose-100 dark:bg-rose-900/30', text: 'text-rose-700 dark:text-rose-300', border: 'border-rose-200 dark:border-rose-800' },
  life: { bg: 'bg-violet-100 dark:bg-violet-900/30', text: 'text-violet-700 dark:text-violet-300', border: 'border-violet-200 dark:border-violet-800' },
};

const STORAGE_KEY = 'frontaliere_firstday_checklist';

// ─── Component ───────────────────────────────────────────────────────────

const FirstDayGuide: React.FC = () => {
  const { t } = useTranslation();
  const nav = useNavigation();
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  // ─── Profile-aware personalization ──────────────────────────
  const profile = useMemo<UserProfileData | null>(() => {
    try {
      return loadUserProfile();
    } catch { return null; }
  }, []);

  const profileHints = useMemo(() => {
    if (!profile) return {};
    const hints: Record<string, string> = {};
    if (profile.frontaliereType === 'permesso_g') {
      hints['permit_g'] = t('firstDay.hint.alreadyPermitG');
    }
    if (profile.familySituation === 'sposato' || profile.familySituation === 'convivente') {
      hints['choose_insurance'] = t('firstDay.hint.familyInsurance');
    }
    if (profile.children && parseInt(profile.children) > 0) {
      hints['tax_setup'] = t('firstDay.hint.childrenTax');
    }
    if (profile.municipality) {
      hints['find_job'] = t('firstDay.hint.fromMunicipality', { municipality: profile.municipality });
    }
    return hints;
  }, [profile, t]);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...completedSteps]));
  }, [completedSteps]);

  const toggleStep = (id: string) => {
    setCompletedSteps(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        addXp(25);
        // Gamification achievements
        if (next.size === 1) unlockAchievement('first_visit');
        if (next.size === 6) unlockAchievement('guide_reader');
        if (next.size === CHECKLIST_STEPS.length) unlockAchievement('comparator_master');
      }
      return next;
    });
  };

  const progress = (completedSteps.size / CHECKLIST_STEPS.length) * 100;
  const completedCount = completedSteps.size;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl p-4 sm:p-6 border border-amber-200 dark:border-amber-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-amber-100 dark:bg-amber-900/50 rounded-xl">
            <Flag className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-2xl font-bold text-amber-900 dark:text-amber-100">{t('firstday.title')}</h2>
        </div>
        <p className="text-amber-700 dark:text-amber-300 text-sm">{t('firstday.subtitle')}</p>
      </div>

      {/* Progress Bar */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-500" />
            <span className="font-bold text-slate-800 dark:text-slate-200">{t('firstday.progress')}</span>
          </div>
          <span className="text-sm font-bold text-slate-500 dark:text-slate-400">{completedCount}/{CHECKLIST_STEPS.length}</span>
        </div>
        <div className="w-full h-3 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-transform duration-500 ease-out origin-left"
            style={{ transform: `scaleX(${progress / 100})` }}
          />
        </div>
        {completedCount === CHECKLIST_STEPS.length && (
          <div className="mt-3 flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
            <Sparkles className="w-5 h-5" />
            <span className="font-bold">{t('firstday.complete')}</span>
          </div>
        )}
      </div>

      {/* Category Legend */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(CATEGORY_COLORS).map(([cat, colors]) => (
          <span key={cat} className={`px-3 py-1 rounded-full text-xs font-bold ${colors.bg} ${colors.text}`}>
            {t(`firstday.cat.${cat}`)}
          </span>
        ))}
      </div>

      {/* Checklist Steps */}
      <div className="space-y-3">
        {CHECKLIST_STEPS.map((step, index) => {
          const isCompleted = completedSteps.has(step.id);
          const isExpanded = expandedStep === step.id;
          const colors = CATEGORY_COLORS[step.category];

          return (
            <div
              key={step.id}
              className={`rounded-xl border transition-colors duration-200 ${
                isCompleted
                  ? 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                  : `bg-white dark:bg-slate-800 ${colors.border}`
              }`}
            >
              <div className="p-4 flex items-center gap-3">
                {/* Step number */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                  isCompleted
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-400'
                }`}>
                  {isCompleted ? '✓' : index + 1}
                </div>

                {/* Checkbox + Content */}
                <button
                  onClick={() => toggleStep(step.id)}
                  className="flex items-center gap-3 flex-1 text-left"
                >
                  {isCompleted
                    ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                    : <Circle className="w-5 h-5 text-slate-300 dark:text-slate-600 shrink-0" />
                  }
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{step.icon}</span>
                      <span className={`font-bold text-sm ${isCompleted ? 'text-emerald-700 dark:text-emerald-300 line-through' : 'text-slate-800 dark:text-slate-200'}`}>
                        {t(`firstday.step.${step.id}`)}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{t(`firstday.step.${step.id}.desc`)}</p>
                  </div>
                </button>

                {/* Time estimate + expand */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="hidden sm:flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                    <Clock className="w-3 h-3" />
                    {step.estimatedDays}
                  </span>
                  <button
                    onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                    className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
                    aria-label={isExpanded ? 'Comprimi' : 'Espandi'}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div className="px-4 pb-4 ml-11 space-y-3 border-t border-slate-100 dark:border-slate-700 pt-3">
                  {/* Profile hint */}
                  {profileHints[step.id] && (
                    <div className="flex items-start gap-2 p-3 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg border border-indigo-200 dark:border-indigo-800">
                      <User className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-indigo-700 dark:text-indigo-300 font-medium">{profileHints[step.id]}</p>
                    </div>
                  )}

                  {/* Substeps */}
                  {step.substeps && (
                    <div className="space-y-1.5">
                      {step.substeps.map((sub, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          {t(`firstday.${sub}`)}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Internal job-board CTA — shown before external links */}
                  {step.jobBoardCta && (
                    <div className="mt-2">
                      <a
                        href={buildPath({ activeTab: 'job-board' })}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          nav.navigateTo('job-board');
                          Analytics.trackUIInteraction('first_day_guide', 'job_board_cta', 'click', 'find_job_step');
                        }}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-colors"
                      >
                        <Briefcase className="w-3.5 h-3.5" />
                        {t('firstday.jobBoard.cta')}
                      </a>
                    </div>
                  )}

                  {/* Links — external portals as secondary resources */}
                  {step.links && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {step.links.map((link, i) => (
                        <a
                          key={i}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-warm-50 dark:bg-warm-950 text-warm-700 dark:text-warm-400 rounded-lg hover:bg-warm-100 dark:hover:bg-warm-900/50 transition-colors font-bold border border-warm-200 dark:border-warm-800"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {link.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FirstDayGuide;
