import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Check, Loader2, Mail } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import {
  companyAlertKey,
  deleteAlert,
  findCompanyAlert,
  subscribeCompanyAlert,
  upgradeBackfilledAlertConsent,
} from '@/services/jobAlertService';
import { savePendingCompanyFollow } from '@/services/companyFollowIntent';
import { upsertNewsletterSubscriber, requestConfirmationEmail } from '@/services/newsletterSubscribers';
import { consentProof } from '@/services/consentTexts';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { reportCaughtError } from '@/services/errorReporter';
import { buildPath } from '@/services/router';

export type CompanyFollowButtonStatus =
  | 'idle'
  | 'loading'
  | 'submitting'
  | 'following'
  | 'error'
  /** Anonymous visitor tapped "Segui": the email field is open (#5012 phase 2). */
  | 'capture'
  /** Opt-in email sent; the follow is parked until the link is clicked. */
  | 'pendingOptIn';

export interface CompanyFollowButtonProps {
  /** Employer display name (`job.company`). */
  company: string;
  /** Optional crawler company key (`job.companyKey`) — improves canonicalisation. */
  companyKey?: string | null;
  /** Authenticated user id. `null`/absent → the anonymous email-capture path. */
  userId?: string | null;
  /** Authenticated user email. `null`/absent → the anonymous email-capture path. */
  email?: string | null;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Slug of the job the user followed from — stored as provenance. */
  sourceJobSlug?: string | null;
  /** Full canonical URL of that job — stored as provenance. */
  sourceJobUrl?: string | null;
  /** Title of that job — stored as provenance. */
  sourceJobTitle?: string | null;
  /** Called on a successful follow (analytics / cache invalidation). */
  onSubscribed?: () => void;
  /** Called on a successful unfollow. */
  onUnsubscribed?: () => void;
  /** Called once an anonymous visitor's opt-in email has been requested. */
  onOptInRequested?: (email: string) => void;
  /** Called when a write throws. */
  onErrored?: (error: unknown) => void;
  /** Test seams. */
  lookup?: typeof findCompanyAlert;
  subscribe?: typeof subscribeCompanyAlert;
  unfollow?: typeof deleteAlert;
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
  captureEmail?: (email: string, intent: { company: string; companyKey?: string | null }) => Promise<void>;
}

/**
 * "Segui questa azienda" — CompanyAlert subscribe/unsubscribe (issue #5012).
 *
 * Pins a job alert to one employer via `specificCompanyKey`, the filter the
 * matcher (services/jobAlertMatching.mjs) has always supported as a hard scope.
 * The persisted token is `companyAlertKey()` — the canonical `/aziende/<slug>/`
 * slug, the ONE normalisation shared with the matcher.
 *
 * ── TWO PATHS (phase 2) ───────────────────────────────────────────────────
 * Signed in  → write the alert immediately (`subscribeCompanyAlert`).
 * Anonymous  → capture the address, subscribe it as PENDING through the site's
 *              existing double opt-in (`upsertNewsletterSubscriber` fires
 *              `newsletterSendConfirmation`), and PARK the follow in
 *              services/companyFollowIntent.ts. App.tsx replays it once the
 *              confirmation link signs the visitor in.
 *
 * Phase 1 returned `null` for anonymous visitors, so the highest-intent reader
 * on the page — someone looking at a specific employer's ad — could not follow
 * at all. No alert document is ever written for an unconfirmed address:
 * consent first, subscription second. That ordering is what double opt-in
 * means, and it is why the intent is parked instead of written optimistically.
 *
 * Unfollow DEACTIVATES the alert (`deleteAlert` → `active:false` + `unsubscribed_at`).
 *
 * An earlier revision only cleared the pin, on the reasoning that keeping one
 * re-targetable row made the follow state readable back. That was wrong in a way that
 * mattered: the row stayed ACTIVE, and `buildAlertProfile` still derives softTokens from
 * the `sourceJobTitle`/`sourceJobSlug` the follow captured — so an unfollowed employer kept
 * producing weak-intent matches built from the title of whatever job the user happened to
 * be reading. An unsubscribe that keeps sending email is a GDPR problem, not a UX nicety.
 * It also kept consuming a MAX_ALERTS_PER_USER slot for a cancelled subscription.
 *
 * Consequence, deliberate: `findCompanyAlert` filters on `active == true`, so a re-follow
 * creates a NEW alert document rather than reviving the deactivated one. That is the
 * correct audit trail — the withdrawal stays on record with its `unsubscribed_at` — and it
 * costs one document, not one query.
 *
 * No new Firestore query: `findCompanyAlert` filters `getUserAlerts()` in
 * memory, reusing the already-deployed (userId, active, createdAt desc)
 * collectionGroup index. `firestore.indexes.json` is NOT applied by CI, so a
 * surface that needed a new index would ship broken.
 */
export default function CompanyFollowButton({
  company,
  companyKey,
  userId,
  email,
  locale,
  sourceJobSlug,
  sourceJobUrl,
  sourceJobTitle,
  onSubscribed,
  onUnsubscribed,
  onOptInRequested,
  onErrored,
  lookup = findCompanyAlert,
  subscribe = subscribeCompanyAlert,
  unfollow = deleteAlert,
  upgradeConsent = upgradeBackfilledAlertConsent,
  captureEmail,
}: CompanyFollowButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CompanyFollowButtonStatus>('loading');
  const [alertId, setAlertId] = useState<string | null>(null);
  const [typedEmail, setTypedEmail] = useState('');
  const [captureError, setCaptureError] = useState('');

  const slug = companyAlertKey(company, companyKey || undefined);
  const signedIn = Boolean(userId && email);

  useEffect(() => {
    let cancelled = false;
    if (!slug || !userId) { setStatus('idle'); return undefined; }
    setStatus('loading');
    lookup(userId, { name: company, companyKey })
      .then((existing) => {
        if (cancelled) return;
        setAlertId(existing?.id ?? null);
        setStatus(existing ? 'following' : 'idle');
      })
      .catch(() => { if (!cancelled) setStatus('idle'); });
    return () => { cancelled = true; };
  }, [company, companyKey, lookup, slug, userId]);

  const handleFollow = useCallback(async () => {
    if (!slug) return;
    // Anonymous: open the capture field instead of writing. The alert needs a
    // confirmed address, and asking for it here IS the growth case — an
    // anonymous visitor who wants one employer's ads is an acquired email.
    if (!signedIn) { setStatus('capture'); return; }
    setStatus('submitting');
    try {
      const created = await subscribe(userId as string, email as string, { name: company, companyKey }, locale, {
        slug: sourceJobSlug ?? null,
        url: sourceJobUrl ?? null,
        title: sourceJobTitle ?? null,
      });
      setAlertId(created.id);
      // #5876 — following a company is the same explicit act, behind the same
      // notice (rendered below on the capture form), as the other 7 surfaces
      // this issue wires up. If this email also carries a travaso alert, the
      // act converts its deduced consent into an explicit one. Never awaited
      // into the error path: a proof that fails to land must not turn a
      // successful follow into an error toast.
      void upgradeConsent(email as string, locale).catch(() => {});
      setStatus('following');
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [company, companyKey, email, locale, onErrored, onSubscribed, signedIn, slug, sourceJobSlug, sourceJobTitle, sourceJobUrl, subscribe, upgradeConsent, userId]);

  /**
   * Anonymous submit. Reuses the site's ONE consent mechanism end to end:
   * `upsertNewsletterSubscriber` writes `status:'pending'` and auto-fires the
   * confirmation email — but only for a genuinely NEW pending record. Following
   * SaveSignInPromptModal's precedent, an address that already exists gets an
   * explicit `purpose:'login'` link instead. Without that branch a returning
   * visitor would tap "Segui", receive no email, and never be followed: silent
   * failure, the exact defect class this feature keeps being audited for.
   */
  const handleCaptureSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;
    const trimmed = typedEmail.trim().toLowerCase();
    if (!validateEmailStrict(trimmed).valid) {
      setCaptureError(t('newsletter.invalidEmail'));
      return;
    }
    setCaptureError('');
    setStatus('submitting');
    try {
      if (captureEmail) {
        await captureEmail(trimmed, { company, companyKey });
      } else {
        const firestore = getFirestore(await getApp());
        const upsert = await upsertNewsletterSubscriber(firestore, {
          email: trimmed,
          preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
          source: 'company_follow_button',
          sourcePage: typeof window !== 'undefined' ? window.location.pathname : '',
          sourceCta: 'company_follow_button',
          sourceComponent: 'CompanyFollowButton',
          sourceRouteFamily: 'community',
          locale: typeof navigator !== 'undefined' ? navigator.language || 'it-IT' : 'it-IT',
          // #5712/#5718: the notice under this form renders the same string
          // in the same locale, so what is stored is what was read.
          ...consentProof('communicationsOptIn', 'email_submit', locale),
          // No `consentGiven`: this form has no consent checkbox, so nothing here
          // is an affirmative opt-in — only "was shown" is true. See the
          // `consentGiven` section of services/consentTexts.ts (#5712).
        });
        if (upsert.existed) await requestConfirmationEmail(trimmed, 'login');
      }
      // Park the follow. It becomes an alert only after the confirmation link
      // lands (App.tsx → flushPendingCompanyFollows), never before.
      savePendingCompanyFollow({
        company,
        companyKey: companyKey ?? null,
        locale: locale as 'it' | 'en' | 'de' | 'fr',
        sourceJobSlug: sourceJobSlug ?? null,
        sourceJobUrl: sourceJobUrl ?? null,
        sourceJobTitle: sourceJobTitle ?? null,
        email: trimmed,
      });
      setStatus('pendingOptIn');
      if (onOptInRequested) onOptInRequested(trimmed);
    } catch (error: unknown) {
      reportCaughtError(error, 'companyFollow.captureEmail');
      setCaptureError(t('jobAlert.companyFollow.error'));
      setStatus('capture');
      if (onErrored) onErrored(error);
    }
  }, [captureEmail, company, companyKey, locale, onErrored, onOptInRequested, sourceJobSlug, sourceJobTitle, sourceJobUrl, status, t, typedEmail]);

  const handleUnfollow = useCallback(async () => {
    if (!alertId || !email) return;
    setStatus('submitting');
    try {
      // Deactivates the alert (active:false + unsubscribed_at) rather than only
      // nulling the pin (#5012 review). Clearing specificCompanyKey alone left the row
      // ACTIVE, and buildAlertProfile still derives softTokens from the sourceJobTitle /
      // sourceJobSlug the follow captured — so an "unfollowed" employer kept sending
      // weak-intent matches from the title of the job the user happened to be reading.
      // It also kept consuming a MAX_ALERTS_PER_USER slot for a subscription the user
      // had explicitly cancelled.
      await unfollow(email, alertId);
      setAlertId(null);
      setStatus('idle');
      if (onUnsubscribed) onUnsubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [alertId, email, onErrored, onUnsubscribed, unfollow]);

  if (!slug) return null;
  if (status === 'loading') return null;

  if (status === 'pendingOptIn') {
    return (
      <div className="mt-3 rounded-lg border border-edge bg-surface-raised px-4 py-3">
        <p className="text-sm font-semibold text-heading flex items-center gap-2">
          <Mail className="w-4 h-4 text-accent" aria-hidden="true" />
          {t('jobAlert.companyFollow.optInSentTitle')}
        </p>
        <p className="mt-1 text-xs text-muted">
          {t('jobAlert.companyFollow.optInSentBody')}
        </p>
      </div>
    );
  }

  const busy = status === 'submitting';
  const following = status === 'following';

  if (status === 'capture' || (busy && !signedIn)) {
    return (
      <form className="mt-3 rounded-lg border border-edge bg-surface-raised px-4 py-3" onSubmit={handleCaptureSubmit}>
        <label className="block text-sm font-semibold text-heading" htmlFor="company-follow-email">
          {t('jobAlert.companyFollow.emailLabel')}
        </label>
        <p className="mt-1 text-xs text-muted">
          {t('jobAlert.companyFollow.emailHint')}
        </p>
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <EmailInput
            id="company-follow-email"
            value={typedEmail}
            onChange={setTypedEmail}
            className="flex-1"
            ariaLabel={t('jobAlert.companyFollow.emailLabel')}
          />
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border border-accent-border bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Building2 className="w-4 h-4" aria-hidden="true" />}
            {t('jobAlert.companyFollow.cta')}
          </button>
        </div>
        <ConsentNotice consentKey="communicationsOptIn" locale={locale} className="mt-2 text-[11px] text-muted leading-relaxed block" />
        {captureError && <p className="mt-2 text-xs text-danger">{captureError}</p>}
      </form>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={following ? handleUnfollow : handleFollow}
        disabled={busy}
        aria-busy={busy}
        aria-pressed={following}
        className={`inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border transition-colors disabled:opacity-60 ${
          following
            ? 'border-edge bg-surface-raised text-body'
            : 'border-accent-border bg-surface text-accent hover:bg-accent-subtle'
        }`}
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : following ? (
          <Check className="w-4 h-4" aria-hidden="true" />
        ) : (
          <Building2 className="w-4 h-4" aria-hidden="true" />
        )}
        {following
          ? t('jobAlert.companyFollow.following', 'Stai seguendo questa azienda')
          : t('jobAlert.companyFollow.cta', 'Segui questa azienda')}
      </button>
      <p className="mt-2 text-xs text-muted">
        {following
          ? t('jobAlert.companyFollow.followingHint', 'Ti scriviamo quando pubblica un nuovo annuncio. Tocca per smettere di seguirla.')
          : t('jobAlert.companyFollow.hint', 'Ricevi una email quando questa azienda pubblica nuovi lavori.')}
      </p>
      {!following && (
        // #5902 review round 1: handleFollow (above) records this same
        // consentKey via upgradeConsent — the notice must be on screen in the
        // signed-in branch too, not only on the anonymous capture form below,
        // or the write would assert consent_text_displayed:true for a formula
        // nobody saw.
        <ConsentNotice
          consentKey="communicationsOptIn"
          locale={locale}
          className="mt-2 text-[11px] text-muted leading-relaxed block"
        />
      )}
      {following && (
        // Entry point to the dedicated manager (#5012 phase 2). Built through
        // buildPath, never a hardcoded /it|/en|… segment — that is what
        // scripts/ci/check-hardcoded-locale-segments.mjs guards.
        <a
          href={buildPath({ activeTab: 'followed-companies' }, locale)}
          className="mt-1 inline-block text-xs font-semibold text-accent hover:underline"
        >
          {t('jobAlert.companyFollow.manageAll')}
        </a>
      )}
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.companyFollow.error', 'Non sono riuscito ad aggiornare il seguito. Riprova.')}
        </p>
      )}
    </div>
  );
}
