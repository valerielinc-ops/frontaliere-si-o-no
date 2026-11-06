/**
 * ConsultingPage — Personalized consulting booking page
 *
 * Two tiers:
 * - Base (€49): 30-min video call, general fiscal overview
 * - Premium (€99): 60-min video call, personalized simulation + written report
 *
 * Booking: Stripe Checkout (one-time payment) → intake form (topic,
 * description, preferred date/time, contact info) → Firestore write →
 * confirmation email to customer + internal inbox. Replaces the previous
 * Calendly embed, whose "30min" event type was deleted on Calendly's side
 * (confirmed live: "This Calendly URL is not valid"). Revenue: €49-99/session.
 */

import React, { useState, useEffect } from 'react';
import { Calendar, CheckCircle, Clock, FileText, Video, Star, ArrowRight, Shield, Users, AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { recaptchaService } from '@/services/recaptchaService';
import { reportCaughtError } from '@/services/errorReporter';
import { CREATE_CONSULTING_CHECKOUT_URL } from '@/services/functionsBase';
import { getFirestore, doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { getApp } from '@/services/firebase';

interface ConsultingTier {
  id: 'base' | 'premium';
  price: number;
  duration: number;
  icon: React.ReactNode;
  popular?: boolean;
}

const TIERS: ConsultingTier[] = [
  {
    id: 'base',
    price: 49,
    duration: 30,
    icon: <Video className="w-6 h-6" />,
  },
  {
    id: 'premium',
    price: 99,
    duration: 60,
    icon: <Star className="w-6 h-6" />,
    popular: true,
  },
];

interface ConsultingOrder {
  tier: 'base' | 'premium';
  status: string;
  detailsSubmitted: boolean;
  customerEmail: string | null;
}

interface IntakeForm {
  topic: string;
  description: string;
  preferredDateStart: string;
  preferredDateEnd: string;
  preferredTimeWindow: string[];
  contactName: string;
  contactPhone: string;
}

const INTAKE_TOPICS = [
  'consulting.intake.topic.fiscal',
  'consulting.intake.topic.contributions',
  'consulting.intake.topic.statusChange',
  'consulting.intake.topic.other',
] as const;

const TIME_WINDOWS = [
  { value: 'morning', key: 'consulting.intake.time.morning' },
  { value: 'afternoon', key: 'consulting.intake.time.afternoon' },
  { value: 'evening', key: 'consulting.intake.time.evening' },
] as const;

const todayIso = () => new Date().toISOString().slice(0, 10);

const ConsultingPage: React.FC = () => {
  const { t, locale } = useTranslation();
  const [selectedTier, setSelectedTier] = useState<'base' | 'premium' | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState<'base' | 'premium' | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const [sessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('session_id');
  });
  const [order, setOrder] = useState<ConsultingOrder | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [pollGaveUp, setPollGaveUp] = useState(false);

  const [intake, setIntake] = useState<IntakeForm>({
    topic: '',
    description: '',
    preferredDateStart: '',
    preferredDateEnd: '',
    preferredTimeWindow: [],
    contactName: '',
    contactPhone: '',
  });
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    Analytics.trackPageView('/consulenza/', 'Consulting Page');
    Analytics.trackUIInteraction('consulting', 'page', 'consulting_page', 'view');
  }, []);

  // ── Checkout-return polling ──────────────────────────────
  // Stripe webhook flips the order 'paid' async — poll credits every 2s
  // (max 15×, ~30s) until it lands, same pattern as PublisherPublishPage.
  useEffect(() => {
    if (!sessionId || order || pollGaveUp) return;
    if (pollCount >= 15) {
      setPollGaveUp(true);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const firestore = getFirestore(await getApp());
        const snap = await getDoc(doc(firestore, 'consulting_orders', sessionId));
        if (snap.exists()) {
          setOrder(snap.data() as ConsultingOrder);
          Analytics.trackUIInteraction('consulting', 'checkout', 'return', 'success');
          return;
        }
      } catch (error) {
        reportCaughtError(error, 'consulting.pollOrder');
      }
      setPollCount((n) => n + 1);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [sessionId, order, pollGaveUp, pollCount]);

  const handleBooking = async (tier: ConsultingTier) => {
    setCheckoutError(null);
    setCheckoutLoading(tier.id);
    Analytics.trackSelectContent('consulting_booking', tier.id);
    try {
      const origin = `${window.location.origin}${window.location.pathname}`;
      const resp = await fetch(CREATE_CONSULTING_CHECKOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: tier.id,
          successUrl: `${origin}?consulting_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: origin,
          locale,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.url) throw new Error(`checkout_failed:${resp.status}`);
      Analytics.trackExternalLink(data.url, `consulting_${tier.id}`);
      window.location.href = data.url;
    } catch (error) {
      setCheckoutLoading(null);
      setCheckoutError(t('consulting.checkoutError'));
      Analytics.trackUIInteraction('consulting', 'checkout', tier.id, 'error');
      reportCaughtError(error, 'consulting.handleBooking');
    }
  };

  const toggleTimeWindow = (value: string) => {
    setIntake((prev) => ({
      ...prev,
      preferredTimeWindow: prev.preferredTimeWindow.includes(value)
        ? prev.preferredTimeWindow.filter((v) => v !== value)
        : [...prev.preferredTimeWindow, value],
    }));
  };

  const isIntakeValid = Boolean(
    intake.topic &&
    intake.description.trim().length >= 10 &&
    intake.preferredDateStart &&
    intake.preferredDateEnd &&
    intake.preferredDateEnd >= intake.preferredDateStart &&
    intake.contactName.trim(),
  );

  const handleIntakeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isIntakeValid || submitStatus === 'submitting' || !sessionId) return;
    setSubmitStatus('submitting');
    setSubmitError('');
    try {
      const token = await recaptchaService.getTokenForApi('CONSULTING_DETAILS');
      if (!token) throw new Error('recaptcha_token_missing');
      const verification = await recaptchaService.verifyToken(token, 'CONSULTING_DETAILS');
      if (!verification.passed) throw new Error(`recaptcha_blocked:${verification.error ?? 'unknown'}`);

      const firestore = getFirestore(await getApp());
      await updateDoc(doc(firestore, 'consulting_orders', sessionId), {
        topic: intake.topic,
        description: intake.description.trim(),
        preferredDateStart: intake.preferredDateStart,
        preferredDateEnd: intake.preferredDateEnd,
        preferredTimeWindow: intake.preferredTimeWindow,
        contactName: intake.contactName.trim(),
        contactPhone: intake.contactPhone.trim() || null,
        detailsSubmitted: true,
        detailsSubmittedAt: serverTimestamp(),
      });
      setOrder((prev) => (prev ? { ...prev, detailsSubmitted: true } : prev));
      Analytics.trackUIInteraction('consulting', 'intake', 'submit', 'success');
    } catch (error) {
      setSubmitStatus('error');
      setSubmitError(t('consulting.intake.error'));
      Analytics.trackUIInteraction('consulting', 'intake', 'submit', 'error');
      reportCaughtError(error, 'consulting.intakeSubmit');
    }
  };

  // ── Checkout-return branch ────────────────────────────────
  if (sessionId) {
    if (order?.detailsSubmitted) {
      return (
        <div className="max-w-2xl mx-auto px-4 py-12 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success-subtle">
            <CheckCircle className="w-8 h-8 text-success" />
          </div>
          <h1 className="text-2xl font-bold font-display text-heading">{t('consulting.thankYou.title')}</h1>
          <p className="text-subtle">{t('consulting.thankYou.body')}</p>
        </div>
      );
    }

    if (order?.status === 'paid') {
      return (
        <div className="max-w-2xl mx-auto px-4 py-12 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success-subtle">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>
            <h1 className="text-2xl font-bold font-display text-heading">{t('consulting.intake.title')}</h1>
            <p className="text-subtle">{t(`consulting.${order.tier}.name`)}</p>
          </div>

          <form onSubmit={handleIntakeSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.topicLabel')}</label>
              <select
                value={intake.topic}
                onChange={(e) => setIntake((prev) => ({ ...prev, topic: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                required
              >
                <option value="" disabled>{t('consulting.intake.topicLabel')}</option>
                {INTAKE_TOPICS.map((key) => (
                  <option key={key} value={key}>{t(key)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.descriptionLabel')}</label>
              <textarea
                value={intake.description}
                onChange={(e) => setIntake((prev) => ({ ...prev, description: e.target.value }))}
                placeholder={t('consulting.intake.descriptionPlaceholder')}
                rows={4}
                className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.dateRangeLabel')}</label>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="date"
                  value={intake.preferredDateStart}
                  min={todayIso()}
                  onChange={(e) => setIntake((prev) => ({ ...prev, preferredDateStart: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                  required
                />
                <input
                  type="date"
                  value={intake.preferredDateEnd}
                  min={intake.preferredDateStart || todayIso()}
                  onChange={(e) => setIntake((prev) => ({ ...prev, preferredDateEnd: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.timeLabel')}</label>
              <div className="flex flex-wrap gap-3">
                {TIME_WINDOWS.map(({ value, key }) => (
                  <label key={value} className="inline-flex items-center gap-2 text-sm text-body">
                    <input
                      type="checkbox"
                      checked={intake.preferredTimeWindow.includes(value)}
                      onChange={() => toggleTimeWindow(value)}
                    />
                    {t(key)}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.nameLabel')}</label>
                <input
                  type="text"
                  value={intake.contactName}
                  onChange={(e) => setIntake((prev) => ({ ...prev, contactName: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-body mb-1.5">{t('consulting.intake.phoneLabel')}</label>
                <input
                  type="tel"
                  value={intake.contactPhone}
                  onChange={(e) => setIntake((prev) => ({ ...prev, contactPhone: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-body"
                />
              </div>
            </div>

            {submitStatus === 'error' && (
              <p className="text-sm text-danger flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                {submitError}
              </p>
            )}

            <button
              type="submit"
              disabled={!isIntakeValid || submitStatus === 'submitting'}
              className="w-full py-3 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-on-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitStatus === 'submitting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {t('consulting.intake.submit')}
            </button>
          </form>
        </div>
      );
    }

    if (pollGaveUp) {
      return (
        <div className="max-w-xl mx-auto px-4 py-12 text-center space-y-4">
          <AlertTriangle className="w-8 h-8 text-warning mx-auto" />
          <p className="text-subtle">{t('consulting.pollTimeout')}</p>
        </div>
      );
    }

    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <Loader2 className="w-8 h-8 text-link mx-auto animate-spin" />
        <p className="text-subtle">{t('consulting.pollWaiting')}</p>
      </div>
    );
  }

  // ── Pricing page ───────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent-subtle text-accent rounded-full text-xs font-medium">
          <Calendar className="w-4 h-4" />
          {t('consulting.badge')}
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold font-display text-heading">
          {t('consulting.title')}
        </h1>
        <p className="text-subtle max-w-2xl mx-auto text-lg">
          {t('consulting.subtitle')}
        </p>
      </div>

      {/* Trust bar */}
      <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Shield className="w-4 h-4 text-success" />
          {t('consulting.trust.secure')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Users className="w-4 h-4 text-link" />
          {t('consulting.trust.experts')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle className="w-4 h-4 text-warning" />
          {t('consulting.trust.satisfaction')}
        </span>
      </div>

      {/* Pricing cards */}
      <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
        {TIERS.map((tier) => {
          const isSelected = selectedTier === tier.id;
          const features = (t(`consulting.${tier.id}.features`) || '').split('|').filter(Boolean);
          const isLoading = checkoutLoading === tier.id;

          return (
            <div
              key={tier.id}
              onClick={() => setSelectedTier(tier.id)}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setSelectedTier(tier.id);
              }}
              className={`relative rounded-2xl border-2 p-4 sm:p-6 cursor-pointer transition-colors duration-200 ${
                tier.popular
                  ? 'border-warning-border bg-warning-subtle'
                  : 'border-edge bg-surface/50'
              } ${isSelected ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-alt scale-[1.02]' : 'hover:border-edge'}`}
            >
              {tier.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-warning text-on-accent text-xs font-bold rounded-full">
                  {t('consulting.popular')}
                </div>
              )}

              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-xl ${
                    tier.popular
                      ? 'bg-warning-subtle text-warning'
                      : 'bg-accent-subtle text-accent'
                  }`}>
                    {tier.icon}
                  </div>
                  <div>
                    <h3 className="font-bold font-display text-lg text-heading">
                      {t(`consulting.${tier.id}.name`)}
                    </h3>
                    <span className="text-sm text-muted inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {tier.duration} min
                    </span>
                  </div>
                </div>

                {/* Price */}
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl sm:text-4xl font-bold text-heading">€{tier.price}</span>
                  <span className="text-muted text-sm">/{t('consulting.perSession')}</span>
                </div>

                {/* Description */}
                <p className="text-sm text-subtle">
                  {t(`consulting.${tier.id}.description`)}
                </p>

                {/* Features */}
                <ul className="space-y-2.5">
                  {features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                        tier.popular
                          ? 'text-warning'
                          : 'text-link'
                      }`} />
                      <span className="text-body">{feature.trim()}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <button
                  onClick={(e) => { e.stopPropagation(); void handleBooking(tier); }}
                  disabled={checkoutLoading !== null}
                  className={`w-full py-3 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    tier.popular
                      ? 'bg-warning-strong hover:bg-warning-strong-hover text-on-accent'
                      : 'bg-accent hover:bg-accent-hover text-on-accent'
                  }`}
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
                  {t('consulting.book')}
                  {!isLoading && <ArrowRight className="w-4 h-4" />}
                </button>
                {checkoutError && isSelected && (
                  <p className="text-xs text-danger flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {checkoutError}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* How it works */}
      <div className="max-w-3xl mx-auto">
        <h2 className="text-xl font-bold font-display text-heading text-center mb-6">
          {t('consulting.howItWorks')}
        </h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { icon: <Calendar className="w-5 h-5" />, step: 1, key: 'step1' },
            { icon: <Video className="w-5 h-5" />, step: 2, key: 'step2' },
            { icon: <FileText className="w-5 h-5" />, step: 3, key: 'step3' },
          ].map(({ icon, step, key }) => (
            <div key={step} className="text-center p-4 rounded-xl bg-surface-alt/50 space-y-2">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent-subtle text-accent font-bold text-sm">
                {step}
              </div>
              <div className="flex justify-center text-subtle">
                {icon}
              </div>
              <h3 className="font-semibold text-sm text-heading">
                {t(`consulting.${key}.title`)}
              </h3>
              <p className="text-sm text-muted">
                {t(`consulting.${key}.desc`)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Topics */}
      <div className="max-w-3xl mx-auto bg-surface-alt/30 rounded-2xl p-4 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold font-display text-heading">
          {t('consulting.topicsTitle')}
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {(t('consulting.topicsList') || '').split('|').filter(Boolean).map((topic, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-body">
              <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
              {topic.trim()}
            </div>
          ))}
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-center text-xs text-muted max-w-2xl mx-auto">
        {t('consulting.disclaimer')}
      </p>
    </div>
  );
};

export default ConsultingPage;
