import React from 'react';
import { CheckCircle2, Calculator, Briefcase, BookOpen, ArrowRight, Star } from 'lucide-react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { buildPath } from '@/services/router';

export const EmailConfirmed: React.FC = () => {
 const { t } = useTranslation();

 const features = [
 {
 id: 'calculator',
 icon: Calculator,
 colorClass: 'from-accent-strong to-accent-strong',
 titleKey: 'emailConfirmed.cta.calculator.title',
 descKey: 'emailConfirmed.cta.calculator.desc',
 href: buildPath({ activeTab: 'calculator' }),
 },
 {
 id: 'jobs',
 icon: Briefcase,
 colorClass: 'from-success-strong to-info-strong',
 titleKey: 'emailConfirmed.cta.jobs.title',
 descKey: 'emailConfirmed.cta.jobs.desc',
 href: buildPath({ activeTab: 'job-board' }),
 },
 {
 id: 'blog',
 icon: BookOpen,
 colorClass: 'from-info-strong to-info-strong',
 titleKey: 'emailConfirmed.cta.blog.title',
 descKey: 'emailConfirmed.cta.blog.desc',
 href: buildPath({ activeTab: 'blog' }),
 },
 ];

 return (
 <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
 <div className="max-w-2xl w-full space-y-6">
 {/* Success Header */}
 <div className="bg-surface rounded-2xl border border-edge p-6 sm:p-8 shadow-xl text-center">
 <div className="flex justify-center mb-5">
 <div className="p-4 bg-gradient-to-br from-success-strong to-info-strong rounded-full shadow-lg">
 <CheckCircle2 className="text-on-accent" size={40} />
 </div>
 </div>
 <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong mb-2">
 {t('emailConfirmed.title')}
 </h1>
 <p className="text-subtle text-sm sm:text-base">
 {t('emailConfirmed.subtitle')}
 </p>
 </div>

 {/* Welcome Message */}
 <div className="bg-success-subtle border border-success-border rounded-2xl p-5 sm:p-6">
 <div className="flex items-start gap-3">
 <Star className="text-success flex-shrink-0 mt-0.5" size={20} />
 <p className="text-success text-sm leading-relaxed">
 {t('emailConfirmed.welcome')}
 </p>
 </div>
 </div>

 {/* Feature CTAs */}
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-6 shadow-lg space-y-4">
 <h2 className="text-base font-bold text-strong">
 {t('emailConfirmed.exploreTitle')}
 </h2>
 <div className="space-y-3">
 {features.map((feature) => (
 <a
 key={feature.id}
 href={feature.href}
 className="flex items-center gap-4 rounded-xl border border-edge p-4 hover:border-accent hover:shadow-md transition-[color,background-color,border-color,box-shadow] group"
 >
 <div className={`p-2.5 bg-gradient-to-br ${feature.colorClass} rounded-xl shadow-md flex-shrink-0`}>
 <feature.icon className="text-on-accent" size={22} />
 </div>
 <div className="flex-1 min-w-0">
 <div className="font-semibold text-strong text-sm">
 {t(feature.titleKey, getCantonI18nParams())}
 </div>
 <div className="text-xs text-subtle mt-0.5">
 {t(feature.descKey, getCantonI18nParams())}
 </div>
 </div>
 <ArrowRight className="text-muted group-hover:text-accent transition-colors flex-shrink-0" size={18} />
 </a>
 ))}
 </div>
 </div>

 {/* Back to Home */}
 <div className="text-center">
 <a
 href="/"
 className="text-sm text-subtle hover:text-accent transition-colors"
 >
 {t('emailConfirmed.backHome')}
 </a>
 </div>
 </div>
 </div>
 );
};
