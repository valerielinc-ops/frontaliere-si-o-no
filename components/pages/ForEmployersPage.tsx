/**
 * ForEmployersPage — employer-facing marketing/landing page that SELLS the paid
 * Publisher Portal. Unlike the auth-gated authoring form (`/pubblica-offerta`),
 * this page is public and indexable: it explains WHY an employer should pay to
 * reach the cross-border (frontalieri) audience.
 *
 * Conversion funnel: hero CTA → publish form (`activeTab: 'publish'`); a
 * secondary CTA routes to the contact page for sales questions.
 *
 * Styling: semantic Tailwind tokens only (no inline hex, no `dark:` classes),
 * mobile-first, lucide icons (no imagery), one <h1>.
 */

import React, { useEffect } from 'react';
import {
 Briefcase,
 ArrowRight,
 Check,
 X,
 Eye,
 Mail,
 BarChart3,
 Globe,
 Sparkles,
 CreditCard,
 Clock,
 Users,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';
import { Analytics } from '@/services/analytics';

/** Stat tiles — real (approximate) audience figures, all values via i18n. */
const STAT_TILES: { icon: React.ReactNode; valueKey: string; labelKey: string }[] = [
 { icon: <Eye className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.views.value', labelKey: 'publisherLanding.stat.views.label' },
 { icon: <Users className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.subscribers.value', labelKey: 'publisherLanding.stat.subscribers.label' },
 { icon: <Globe className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.audience.value', labelKey: 'publisherLanding.stat.audience.label' },
 { icon: <Sparkles className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.seo.value', labelKey: 'publisherLanding.stat.seo.label' },
];

/** Comparison rows — each feature, whether it's in Free vs Sponsored. */
const COMPARISON_ROWS: { labelKey: string; free: boolean; sponsored: boolean }[] = [
 { labelKey: 'publisherLanding.compare.row.listing', free: true, sponsored: true },
 { labelKey: 'publisherLanding.compare.row.seoPage', free: true, sponsored: true },
 { labelKey: 'publisherLanding.compare.row.featured', free: false, sponsored: true },
 { labelKey: 'publisherLanding.compare.row.newsletter', free: false, sponsored: true },
 { labelKey: 'publisherLanding.compare.row.inHouse', free: false, sponsored: true },
 { labelKey: 'publisherLanding.compare.row.analytics', free: false, sponsored: true },
];

const STEPS: { icon: React.ReactNode; titleKey: string; descKey: string }[] = [
 { icon: <Sparkles className="w-6 h-6" aria-hidden="true" />, titleKey: 'publisherLanding.step.create.title', descKey: 'publisherLanding.step.create.desc' },
 { icon: <CreditCard className="w-6 h-6" aria-hidden="true" />, titleKey: 'publisherLanding.step.pay.title', descKey: 'publisherLanding.step.pay.desc' },
 { icon: <Clock className="w-6 h-6" aria-hidden="true" />, titleKey: 'publisherLanding.step.live.title', descKey: 'publisherLanding.step.live.desc' },
];

const FAQ_ITEMS: { qKey: string; aKey: string }[] = [
 { qKey: 'publisherLanding.faq.payment.q', aKey: 'publisherLanding.faq.payment.a' },
 { qKey: 'publisherLanding.faq.invoice.q', aKey: 'publisherLanding.faq.invoice.a' },
 { qKey: 'publisherLanding.faq.cancel.q', aKey: 'publisherLanding.faq.cancel.a' },
 { qKey: 'publisherLanding.faq.freeVsSponsored.q', aKey: 'publisherLanding.faq.freeVsSponsored.a' },
 { qKey: 'publisherLanding.faq.timing.q', aKey: 'publisherLanding.faq.timing.a' },
];

const ForEmployersPage: React.FC = () => {
 const { t, locale } = useTranslation();

 const publishPath = buildPath({ activeTab: 'publish' }, locale);
 const contactPath = buildPath({ activeTab: 'contact' }, locale);

 useEffect(() => {
 Analytics.trackPageView('/per-le-aziende', 'For Employers Landing');
 Analytics.trackUIInteraction('publisher', 'page', 'for_employers', 'view');
 }, []);

 // ── SEO meta (title + description) — this page IS indexable. ──
 useEffect(() => {
 const prevTitle = document.title;
 document.title = t('publisherLanding.metaTitle');
 const meta = document.querySelector('meta[name="description"]');
 const prevDesc = meta?.getAttribute('content') ?? null;
 if (meta) meta.setAttribute('content', t('publisherLanding.metaDescription'));
 return () => {
 document.title = prevTitle;
 if (meta && prevDesc != null) meta.setAttribute('content', prevDesc);
 };
 }, [t]);

 const primaryCtaClass =
 'inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors shadow-sm no-underline';
 const secondaryCtaClass =
 'inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors no-underline';

 return (
 <div className="max-w-5xl mx-auto px-4 py-8 space-y-16">
 {/* ── Hero ──────────────────────────────────────────────── */}
 <section className="text-center pt-4">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-5">
 <Briefcase className="w-7 h-7 text-link" aria-hidden="true" />
 </div>
 <h1 className="text-3xl sm:text-4xl font-bold font-display text-strong mb-4">
 {t('publisherLanding.hero.title')}
 </h1>
 <p className="text-base sm:text-lg text-subtle max-w-2xl mx-auto mb-8">
 {t('publisherLanding.hero.subtitle')}
 </p>
 <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
 <a
 href={publishPath}
 className={primaryCtaClass}
 onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'hero_publish', 'click')}
 >
 <Briefcase className="w-4 h-4" aria-hidden="true" />
 {t('publisherLanding.hero.ctaPrimary')}
 </a>
 <a
 href={contactPath}
 className={secondaryCtaClass}
 onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'hero_contact', 'click')}
 >
 <Mail className="w-4 h-4" aria-hidden="true" />
 {t('publisherLanding.hero.ctaSecondary')}
 </a>
 </div>
 </section>

 {/* ── Audience / trust stats ────────────────────────────── */}
 <section aria-labelledby="for-employers-stats-heading">
 <h2 id="for-employers-stats-heading" className="sr-only">
 {t('publisherLanding.stats.heading')}
 </h2>
 <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
 {STAT_TILES.map(tile => (
 <div
 key={tile.valueKey}
 className="rounded-2xl border border-edge bg-surface-alt p-5 text-center"
 >
 <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent-subtle text-link mb-3">
 {tile.icon}
 </div>
 <p className="text-xl sm:text-2xl font-bold font-display text-strong">
 {t(tile.valueKey)}
 </p>
 <p className="text-xs text-subtle mt-1">{t(tile.labelKey)}</p>
 </div>
 ))}
 </div>
 <p className="text-xs text-muted text-center mt-3">
 {t('publisherLanding.stats.disclaimer')}
 </p>
 </section>

 {/* ── Free vs Sponsored comparison ──────────────────────── */}
 <section aria-labelledby="for-employers-compare-heading">
 <div className="text-center mb-6">
 <h2
 id="for-employers-compare-heading"
 className="text-2xl font-bold font-display text-strong mb-2"
 >
 {t('publisherLanding.compare.heading')}
 </h2>
 <p className="text-sm text-subtle max-w-xl mx-auto">
 {t('publisherLanding.compare.subtitle')}
 </p>
 </div>
 <div className="overflow-x-auto rounded-2xl border border-edge">
 <table className="w-full text-sm border-collapse">
 <caption className="sr-only">{t('publisherLanding.compare.heading')}</caption>
 <thead>
 <tr className="bg-surface-alt">
 <th scope="col" className="text-left font-semibold text-body p-4">
 {t('publisherLanding.compare.featureCol')}
 </th>
 <th scope="col" className="text-center font-semibold text-body p-4">
 {t('publisherLanding.compare.freeCol')}
 </th>
 <th scope="col" className="text-center font-semibold text-strong p-4 bg-accent-subtle">
 {t('publisherLanding.compare.sponsoredCol')}
 </th>
 </tr>
 </thead>
 <tbody>
 {COMPARISON_ROWS.map(row => (
 <tr key={row.labelKey} className="border-t border-edge">
 <th scope="row" className="text-left font-normal text-body p-4">
 {t(row.labelKey)}
 </th>
 <td className="text-center p-4">
 {row.free ? (
 <Check className="w-5 h-5 text-success inline" aria-label={t('publisherLanding.compare.included')} />
 ) : (
 <X className="w-5 h-5 text-muted inline" aria-label={t('publisherLanding.compare.notIncluded')} />
 )}
 </td>
 <td className="text-center p-4 bg-accent-subtle/40">
 {row.sponsored ? (
 <Check className="w-5 h-5 text-success inline" aria-label={t('publisherLanding.compare.included')} />
 ) : (
 <X className="w-5 h-5 text-muted inline" aria-label={t('publisherLanding.compare.notIncluded')} />
 )}
 </td>
 </tr>
 ))}
 <tr className="border-t border-edge bg-surface-alt">
 <th scope="row" className="text-left font-semibold text-strong p-4">
 {t('publisherLanding.compare.priceRow')}
 </th>
 <td className="text-center font-semibold text-body p-4">
 {t('publisherLanding.compare.freePrice')}
 </td>
 <td className="text-center font-semibold text-strong p-4 bg-accent-subtle">
 {t('publisherLanding.compare.sponsoredPrice')}
 </td>
 </tr>
 </tbody>
 </table>
 </div>
 </section>

 {/* ── How it works ──────────────────────────────────────── */}
 <section aria-labelledby="for-employers-steps-heading">
 <h2
 id="for-employers-steps-heading"
 className="text-2xl font-bold font-display text-strong text-center mb-8"
 >
 {t('publisherLanding.steps.heading')}
 </h2>
 <ol className="grid grid-cols-1 sm:grid-cols-3 gap-5 list-none p-0 m-0">
 {STEPS.map((step, i) => (
 <li
 key={step.titleKey}
 className="rounded-2xl border border-edge bg-surface-alt p-6 text-center"
 >
 <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent-subtle text-link mb-4">
 {step.icon}
 </div>
 <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">
 {t('publisherLanding.steps.stepLabel', { n: i + 1 })}
 </p>
 <h3 className="text-base font-semibold font-display text-strong mb-2">
 {t(step.titleKey)}
 </h3>
 <p className="text-sm text-subtle">{t(step.descKey)}</p>
 </li>
 ))}
 </ol>
 </section>

 {/* ── FAQ ───────────────────────────────────────────────── */}
 <section aria-labelledby="for-employers-faq-heading">
 <h2
 id="for-employers-faq-heading"
 className="text-2xl font-bold font-display text-strong text-center mb-6"
 >
 {t('publisherLanding.faq.heading')}
 </h2>
 <div className="space-y-3 max-w-2xl mx-auto">
 {FAQ_ITEMS.map(item => (
 <details
 key={item.qKey}
 className="group rounded-2xl border border-edge bg-surface-alt p-4"
 >
 <summary className="flex items-center justify-between gap-2 text-sm font-semibold text-strong cursor-pointer list-none [&::-webkit-details-marker]:hidden">
 <span>{t(item.qKey)}</span>
 <span className="text-muted text-xs group-open:rotate-180 transition-transform" aria-hidden="true">
 ▼
 </span>
 </summary>
 <p className="mt-3 text-sm text-subtle leading-relaxed">{t(item.aKey)}</p>
 </details>
 ))}
 </div>
 </section>

 {/* ── Final CTA band ────────────────────────────────────── */}
 <section className="rounded-3xl border border-accent-border bg-accent-subtle p-8 sm:p-10 text-center">
 <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-on-accent mb-4">
 <BarChart3 className="w-6 h-6" aria-hidden="true" />
 </div>
 <h2 className="text-2xl font-bold font-display text-strong mb-2">
 {t('publisherLanding.finalCta.title')}
 </h2>
 <p className="text-sm text-subtle max-w-xl mx-auto mb-6">
 {t('publisherLanding.finalCta.subtitle')}
 </p>
 <a
 href={publishPath}
 className={primaryCtaClass}
 onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'final_publish', 'click')}
 >
 {t('publisherLanding.finalCta.button')}
 <ArrowRight className="w-4 h-4" aria-hidden="true" />
 </a>
 </section>
 </div>
 );
};

export default ForEmployersPage;
