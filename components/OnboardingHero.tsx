import React from 'react';
import { MapPin, ArrowLeftRight, Briefcase, FileText, ArrowRight } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

const STORAGE_KEY = 'frontaliere_returning_visitor';

export function isReturningVisitor(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return true;
  }
}

export function markAsReturningVisitor(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true');
  } catch { /* ignore */ }
}

interface OnboardingHeroProps {
  onNavigate: (tab: string, subTab?: string) => void;
  onDismiss: () => void;
}

const PATHS = [
  {
    id: 'evaluate',
    icon: MapPin,
    titleKey: 'onboarding.path.evaluate',
    descKey: 'onboarding.path.evaluate.desc',
    tab: 'calculator',
    gradient: 'from-blue-500 to-blue-600',
    bgLight: 'bg-blue-50',
    bgDark: 'dark:bg-blue-950/30',
    borderHover: 'hover:border-blue-300 dark:hover:border-blue-700',
    iconBg: 'bg-blue-100 dark:bg-blue-900/50',
  },
  {
    id: 'commuter',
    icon: ArrowLeftRight,
    titleKey: 'onboarding.path.commuter',
    descKey: 'onboarding.path.commuter.desc',
    tab: 'confronti',
    gradient: 'from-emerald-500 to-emerald-600',
    bgLight: 'bg-emerald-50',
    bgDark: 'dark:bg-emerald-950/30',
    borderHover: 'hover:border-emerald-300 dark:hover:border-emerald-700',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/50',
  },
  {
    id: 'jobs',
    icon: Briefcase,
    titleKey: 'onboarding.path.jobs',
    descKey: 'onboarding.path.jobs.desc',
    tab: 'job-board',
    gradient: 'from-violet-500 to-violet-600',
    bgLight: 'bg-violet-50',
    bgDark: 'dark:bg-violet-950/30',
    borderHover: 'hover:border-violet-300 dark:hover:border-violet-700',
    iconBg: 'bg-violet-100 dark:bg-violet-900/50',
  },
  {
    id: 'tax',
    icon: FileText,
    titleKey: 'onboarding.path.tax',
    descKey: 'onboarding.path.tax.desc',
    tab: 'fisco',
    gradient: 'from-amber-500 to-amber-600',
    bgLight: 'bg-amber-50',
    bgDark: 'dark:bg-amber-950/30',
    borderHover: 'hover:border-amber-300 dark:hover:border-amber-700',
    iconBg: 'bg-amber-100 dark:bg-amber-900/50',
  },
] as const;

export default function OnboardingHero({ onNavigate, onDismiss }: OnboardingHeroProps) {
  const { t } = useTranslation();

  const handlePathClick = (path: typeof PATHS[number]) => {
    markAsReturningVisitor();
    Analytics.trackExternalLink('onboarding', `path_${path.id}`);
    onNavigate(path.tab);
  };

  const handleSkip = () => {
    markAsReturningVisitor();
    Analytics.trackExternalLink('onboarding', 'skip_to_calculator');
    onDismiss();
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
      {/* Header */}
      <div className="text-center mb-8 sm:mb-10">
        <h2 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100 mb-2">
          {t('onboarding.welcome')}
        </h2>
        <p className="text-base sm:text-lg text-slate-600 dark:text-slate-400">
          {t('onboarding.subtitle')}
        </p>
      </div>

      {/* Path cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5 mb-8">
        {PATHS.map((path) => {
          const Icon = path.icon;
          return (
            <button
              key={path.id}
              onClick={() => handlePathClick(path)}
              aria-label={t(path.titleKey)}
              className={`
                group relative text-left p-5 sm:p-6 rounded-2xl
                bg-white dark:bg-slate-800
                border border-slate-200 dark:border-slate-700
                ${path.borderHover}
                shadow-sm hover:shadow-md
                transition-all duration-200 ease-in-out
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2
                dark:focus-visible:ring-offset-slate-900
              `}
            >
              {/* Icon */}
              <div className={`
                inline-flex items-center justify-center w-11 h-11 rounded-xl mb-3
                bg-gradient-to-br ${path.gradient} text-white
                shadow-sm
              `}>
                <Icon size={22} strokeWidth={2} />
              </div>

              {/* Title */}
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1.5 pr-6">
                {t(path.titleKey)}
              </h3>

              {/* Description */}
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {t(path.descKey)}
              </p>

              {/* Arrow indicator */}
              <ArrowRight
                size={16}
                className="absolute top-6 right-5 text-slate-400 dark:text-slate-500 group-hover:translate-x-0.5 transition-transform"
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      {/* Skip link */}
      <div className="text-center">
        <button
          onClick={handleSkip}
          className="
            inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400
            hover:text-blue-600 dark:hover:text-blue-400
            transition-colors duration-150
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:rounded-sm
          "
        >
          {t('onboarding.skipToCalculator')}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
