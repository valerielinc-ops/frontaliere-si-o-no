/**
 * ForEmployersPage — employer-facing marketing/landing page that SELLS the paid
 * Publisher Portal. Unlike the auth-gated authoring form (`/pubblica-offerta`),
 * this page is public and indexable: it explains WHY an employer should pay to
 * reach the cross-border (frontalieri) audience.
 *
 * Conversion funnel: hero CTA → publish form (`activeTab: 'publish'`); a
 * secondary CTA routes to the contact page for sales questions. The Free vs
 * Sponsored choice is the centrepiece — two plan cards give Sponsored a warm
 * "gold tier" identity (Star + warning token) so the upsell reads at a glance.
 *
 * Styling: semantic Tailwind tokens only (no inline hex, no `dark:` classes),
 * mobile-first, lucide icons (no imagery), one <h1>.
 */

import React, { useEffect } from 'react';
import {
  Briefcase,
  ArrowRight,
  Check,
  Eye,
  Mail,
  BarChart3,
  Globe,
  Sparkles,
  CreditCard,
  Clock,
  Users,
  Star,
  Send,
  Inbox,
  Search,
  TrendingUp,
  ListChecks,
  Image,
  Headset,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';
import { Analytics } from '@/services/analytics';
import { useCountUp } from '@/hooks/useCountUp';
import { PRICE_PER_UNIT_CHF, PRICING_CURRENCY } from '@/services/publisherPricing';

/** Stat tiles — real (approximate) audience figures, all values via i18n. */
const STAT_TILES: { icon: React.ReactNode; valueKey: string; labelKey: string; primary?: boolean }[] = [
  { icon: <Eye className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.views.value', labelKey: 'publisherLanding.stat.views.label', primary: true },
  { icon: <Users className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.subscribers.value', labelKey: 'publisherLanding.stat.subscribers.label' },
  { icon: <Globe className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.audience.value', labelKey: 'publisherLanding.stat.audience.label' },
  { icon: <Sparkles className="w-5 h-5" aria-hidden="true" />, valueKey: 'publisherLanding.stat.seo.value', labelKey: 'publisherLanding.stat.seo.label' },
];

/**
 * Feature catalogue — single source of truth for the plan cards. `free` marks
 * the feature as included in the free tier; everything else is sponsored-only.
 * Labels reuse the existing `compare.row.*` i18n keys (no duplication).
 */
const FEATURES: { icon: React.ReactNode; labelKey: string; free: boolean }[] = [
  { icon: <Briefcase className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.listing', free: true },
  { icon: <Search className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.seoPage', free: true },
  { icon: <Image className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.logo', free: true },
  { icon: <Star className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.featured', free: false },
  { icon: <TrendingUp className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.topPlacement', free: false },
  { icon: <ListChecks className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.richEditor', free: false },
  { icon: <Send className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.newsletter', free: false },
  { icon: <Inbox className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.inHouse', free: false },
  { icon: <BarChart3 className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.analytics', free: false },
  { icon: <Headset className="w-4 h-4" aria-hidden="true" />, labelKey: 'publisherLanding.compare.row.teamSupport', free: false },
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

/**
 * Split a localized stat string into a count-up-able number + the surrounding
 * text. "100'000+" → {number: 100000, suffix: "+"}; "Italia↔Ticino" → no
 * number (rendered as-is). Keeps i18n the source of truth — no hardcoded digits.
 */
function parseStat(value: string): { number: number; prefix: string; suffix: string } | null {
  const m = value.match(/^(\D*?)([\d][\d'’.,\s]*)(.*)$/);
  if (!m) return null;
  const digits = m[2].replace(/[^\d]/g, '');
  if (!digits) return null;
  return { number: Number(digits), prefix: m[1], suffix: m[3] };
}

/** Renders a stat value, counting up the numeric part on mount when present. */
function StatValue({ value }: { value: string }): React.ReactElement {
  const parsed = parseStat(value);
  const display = useCountUp(parsed?.number ?? 0, { active: parsed != null });
  if (!parsed) return <>{value}</>;
  return <>{parsed.prefix}{display.toLocaleString('it-CH')}{parsed.suffix}</>;
}

const ForEmployersPage: React.FC = () => {
  const { t, locale } = useTranslation();

  const publishPath = buildPath({ activeTab: 'publish' }, locale);
  const contactPath = buildPath({ activeTab: 'contact' }, locale);

  useEffect(() => {
    Analytics.trackPageView('/per-le-aziende/', 'For Employers Landing');
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

  const freeFeatures = FEATURES.filter(f => f.free);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-16">
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="text-center pt-4 animate-fade-in-up">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-link bg-accent-subtle border border-accent-border mb-5">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          {t('publisherLanding.hero.eyebrow')}
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold font-display text-strong mb-4 max-w-3xl mx-auto leading-tight">
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
        <p className="inline-flex items-center gap-1.5 text-xs text-muted mt-4">
          <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" />
          {t('publisherLanding.hero.trust')}
        </p>
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
              className={`rounded-2xl border p-5 text-center ${
                tile.primary ? 'border-accent-border bg-accent-subtle' : 'border-edge bg-surface-alt'
              }`}
            >
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-surface text-link mb-3 border border-edge">
                {tile.icon}
              </div>
              <p className="text-xl sm:text-2xl font-bold font-display text-strong tabular-nums">
                <StatValue value={t(tile.valueKey)} />
              </p>
              <p className="text-xs text-subtle mt-1">{t(tile.labelKey)}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted text-center mt-3">
          {t('publisherLanding.stats.disclaimer')}
        </p>
      </section>

      {/* ── Free vs Sponsored plan cards (the differentiation) ── */}
      <section aria-labelledby="for-employers-compare-heading">
        <div className="text-center mb-8">
          <h2
            id="for-employers-compare-heading"
            className="text-2xl sm:text-3xl font-bold font-display text-strong mb-2"
          >
            {t('publisherLanding.compare.heading')}
          </h2>
          <p className="text-sm text-subtle max-w-xl mx-auto">
            {t('publisherLanding.compare.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-start">
          {/* Free plan — understated */}
          <div className="rounded-3xl border border-edge bg-surface-alt p-6 sm:p-7">
            <p className="text-sm font-semibold text-subtle uppercase tracking-wide">
              {t('publisherLanding.plan.free.name')}
            </p>
            <p className="mt-2 text-3xl font-bold font-display text-strong">
              {t('publisherLanding.compare.freePrice')}
            </p>
            <p className="mt-1 text-sm text-subtle">{t('publisherLanding.plan.free.tagline')}</p>
            <ul className="mt-5 space-y-2.5">
              {freeFeatures.map(f => (
                <li key={f.labelKey} className="flex items-start gap-2.5 text-sm text-body">
                  <Check className="w-4 h-4 text-success shrink-0 mt-0.5" aria-hidden="true" />
                  {t(f.labelKey)}
                </li>
              ))}
            </ul>
            <a
              href={publishPath}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface transition-colors no-underline"
              onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'plan_free', 'click')}
            >
              {t('publisherLanding.plan.free.cta')}
            </a>
          </div>

          {/* Sponsored plan — the gold tier, visually elevated */}
          <div className="relative rounded-3xl border-2 border-warning-border bg-warning-subtle p-6 sm:p-7 md:-mt-2 md:shadow-sm">
            <span className="absolute -top-3 left-6 inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-warning text-on-accent shadow-sm">
              <Star className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
              {t('publisherLanding.plan.sponsored.badge')}
            </span>
            <p className="text-sm font-semibold text-warning uppercase tracking-wide">
              {t('publisherLanding.plan.sponsored.name')}
            </p>
            <p className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold font-display text-strong">{PRICING_CURRENCY} {PRICE_PER_UNIT_CHF}</span>
              <span className="text-sm text-subtle">{t('publisherLanding.plan.sponsored.priceNote')}</span>
            </p>
            <p className="mt-1 text-sm text-body">{t('publisherLanding.plan.sponsored.tagline')}</p>
            <p className="mt-5 text-xs font-semibold text-strong uppercase tracking-wide">
              {t('publisherLanding.plan.sponsored.everything')}
            </p>
            <ul className="mt-3 space-y-2.5">
              {FEATURES.filter(f => !f.free).map(f => (
                <li key={f.labelKey} className="flex items-start gap-2.5 text-sm text-body">
                  <span className="text-warning shrink-0 mt-0.5">{f.icon}</span>
                  <span className="font-medium text-strong">{t(f.labelKey)}</span>
                </li>
              ))}
            </ul>
            <a
              href={publishPath}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors shadow-sm no-underline"
              onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'plan_sponsored', 'click')}
            >
              <Star className="w-4 h-4 fill-current" aria-hidden="true" />
              {t('publisherLanding.plan.sponsored.cta')}
            </a>
          </div>

          {/* Piano Azienda — flat unlimited tier, premium accent identity */}
          <div className="relative rounded-3xl border-2 border-accent bg-accent-subtle p-6 sm:p-7">
            <span className="absolute -top-3 left-6 inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-accent text-on-accent shadow-sm">
              <BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />
              {t('publisherLanding.plan.azienda.badge')}
            </span>
            <p className="text-sm font-semibold text-link uppercase tracking-wide">
              {t('publisherLanding.plan.azienda.name')}
            </p>
            <p className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold font-display text-strong">{PRICING_CURRENCY} 299</span>
              <span className="text-sm text-subtle">{t('publisherLanding.plan.azienda.priceNote')}</span>
            </p>
            <p className="mt-1 text-sm text-body">{t('publisherLanding.plan.azienda.tagline')}</p>
            <ul className="mt-5 space-y-2.5">
              <li className="flex items-start gap-2.5 text-sm">
                <Star className="w-4 h-4 text-link shrink-0 mt-0.5 fill-current" aria-hidden="true" />
                <span className="font-semibold text-strong">{t('publisherLanding.plan.azienda.allAds')}</span>
              </li>
              {FEATURES.filter(f => !f.free).map(f => (
                <li key={f.labelKey} className="flex items-start gap-2.5 text-sm text-body">
                  <span className="text-link shrink-0 mt-0.5">{f.icon}</span>
                  <span className="font-medium text-strong">{t(f.labelKey)}</span>
                </li>
              ))}
            </ul>
            <a
              href={`${publishPath}?tier=azienda`}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-link hover:opacity-90 rounded-xl transition-opacity shadow-sm no-underline"
              onClick={() => Analytics.trackUIInteraction('publisher', 'cta', 'plan_azienda', 'click')}
            >
              {t('publisherLanding.plan.azienda.cta')}
            </a>
          </div>
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
              className="relative rounded-2xl border border-edge bg-surface-alt p-6 text-center"
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
