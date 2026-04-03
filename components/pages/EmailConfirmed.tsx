import React from 'react';
import { CheckCircle2, Calculator, Briefcase, BookOpen, ArrowRight, Star } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';

export const EmailConfirmed: React.FC = () => {
  const { t } = useTranslation();

  const features = [
    {
      id: 'calculator',
      icon: Calculator,
      colorClass: 'from-blue-500 to-blue-600',
      titleKey: 'emailConfirmed.cta.calculator.title',
      descKey: 'emailConfirmed.cta.calculator.desc',
      href: buildPath({ activeTab: 'calculator' }),
    },
    {
      id: 'jobs',
      icon: Briefcase,
      colorClass: 'from-emerald-500 to-teal-600',
      titleKey: 'emailConfirmed.cta.jobs.title',
      descKey: 'emailConfirmed.cta.jobs.desc',
      href: buildPath({ activeTab: 'job-board' }),
    },
    {
      id: 'blog',
      icon: BookOpen,
      colorClass: 'from-violet-500 to-purple-600',
      titleKey: 'emailConfirmed.cta.blog.title',
      descKey: 'emailConfirmed.cta.blog.desc',
      href: buildPath({ activeTab: 'blog' }),
    },
  ];

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="max-w-2xl w-full space-y-6">
        {/* Success Header */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 sm:p-8 shadow-xl text-center">
          <div className="flex justify-center mb-5">
            <div className="p-4 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-full shadow-lg">
              <CheckCircle2 className="text-white" size={40} />
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-800 dark:text-slate-100 mb-2">
            {t('emailConfirmed.title')}
          </h1>
          <p className="text-slate-600 dark:text-slate-400 text-sm sm:text-base">
            {t('emailConfirmed.subtitle')}
          </p>
        </div>

        {/* Welcome Message */}
        <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Star className="text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" size={20} />
            <p className="text-emerald-800 dark:text-emerald-300 text-sm leading-relaxed">
              {t('emailConfirmed.welcome')}
            </p>
          </div>
        </div>

        {/* Feature CTAs */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 sm:p-6 shadow-lg space-y-4">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            {t('emailConfirmed.exploreTitle')}
          </h2>
          <div className="space-y-3">
            {features.map((feature) => (
              <a
                key={feature.id}
                href={feature.href}
                className="flex items-center gap-4 rounded-xl border border-slate-200 dark:border-slate-700 p-4 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-[color,background-color,border-color,box-shadow] group"
              >
                <div className={`p-2.5 bg-gradient-to-br ${feature.colorClass} rounded-xl shadow-md flex-shrink-0`}>
                  <feature.icon className="text-white" size={22} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                    {t(feature.titleKey)}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                    {t(feature.descKey)}
                  </div>
                </div>
                <ArrowRight className="text-slate-500 dark:text-slate-600 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors flex-shrink-0" size={18} />
              </a>
            ))}
          </div>
        </div>

        {/* Back to Home */}
        <div className="text-center">
          <a
            href="/"
            className="text-sm text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >
            {t('emailConfirmed.backHome')}
          </a>
        </div>
      </div>
    </div>
  );
};
